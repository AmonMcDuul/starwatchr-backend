using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using Core.Entities.EmailModels;
using Core.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace Api.Controllers;

[ApiController]
[Route("internal/notification-mail")]
public sealed class NotificationMailController(
    IEmailService emailService,
    IConfiguration configuration,
    ILogger<NotificationMailController> logger) : ControllerBase
{
    [HttpGet("ready")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult Ready()
    {
        // Reaching this action means startup and database initialization have completed.
        // This checks API readiness only; it never sends a mail or connects to SMTP.
        return ValidateRelayKey() ?? NoContent();
    }

    private IActionResult? ValidateRelayKey()
    {
        var expected = configuration["NotificationDelivery:ApiKey"];
        var supplied = Request.Headers["X-Notification-Key"].ToString();

        if (string.IsNullOrWhiteSpace(expected) || expected.Length < 32)
            return StatusCode(503, new { error = "Mail delivery is unavailable." });

        if (!CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(Encoding.UTF8.GetBytes(expected)),
                SHA256.HashData(Encoding.UTF8.GetBytes(supplied))))
            return Unauthorized();

        return null;
    }

    [HttpPost]
    [RequestSizeLimit(400000)]
    public async Task<IActionResult> Send([FromBody] NotificationEmail email)
    {
        var rejection = ValidateRelayKey();
        if (rejection is not null)
            return rejection;

        // The public contact endpoint still sends only to EmailSettings.ToEmail.
        // Only this authenticated worker endpoint accepts a subscriber recipient.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await emailService.SendNotificationAsync(email, timeout.Token);
            return Ok(new { id = email.DeliveryId });
        }
        catch (SmtpException)
        {
            logger.LogWarning("SMTP notification delivery failed for job {DeliveryId}", email.DeliveryId);
            return StatusCode(503, new { error = "Mail delivery failed. Please retry." });
        }
        catch (OperationCanceledException)
        {
            return StatusCode(504, new { error = "Mail delivery timed out." });
        }
    }
}

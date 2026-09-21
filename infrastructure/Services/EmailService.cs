using System.Net;
using System.Net.Mail;
using System.Net.Mime;
using System.Text;
using Core.Entities.EmailModels;
using Core.Interfaces;
using Microsoft.Extensions.Options;

namespace Infrastructure.Services;

public class EmailService(IOptions<EmailSettings> emailSettings) : IEmailService
{
    private readonly EmailSettings _settings = emailSettings.Value;

    public async Task SendEmailAsync(string subject, string body)
    {
        using var client = CreateClient();
        using var message = new MailMessage(_settings.FromEmail, _settings.ToEmail, subject, body);
        await client.SendMailAsync(message);
    }

    public async Task SendNotificationAsync(
        NotificationEmail email,
        CancellationToken cancellationToken = default)
    {
        using var client = CreateClient();
        using var message = new MailMessage(_settings.FromEmail, email.ToEmail)
        {
            Subject = email.Subject,
            SubjectEncoding = Encoding.UTF8,
            Body = email.Text,
            BodyEncoding = Encoding.UTF8
        };

        message.AlternateViews.Add(
            AlternateView.CreateAlternateViewFromString(email.Html, Encoding.UTF8, MediaTypeNames.Text.Html));

        // Stable across worker retries. SMTP itself does not guarantee exactly-once delivery.
        message.Headers.Add("Message-ID", $"<{email.DeliveryId}@{message.From!.Host}>");

        if (email.UnsubscribeUrl is not null)
        {
            var url = new Uri(email.UnsubscribeUrl, UriKind.Absolute);
            if (url.Scheme != Uri.UriSchemeHttps && !(url.Scheme == Uri.UriSchemeHttp && url.IsLoopback))
                throw new ArgumentException("Unsubscribe links require HTTPS.", nameof(email));

            message.Headers.Add("List-Unsubscribe", $"<{url.AbsoluteUri}>");
            message.Headers.Add("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
        }

        await client.SendMailAsync(message, cancellationToken);
    }

    protected virtual SmtpClient CreateClient() => new(_settings.SmtpServer, _settings.SmtpPort)
    {
        Credentials = new NetworkCredential(_settings.FromEmail, _settings.Password),
        EnableSsl = true
    };
}

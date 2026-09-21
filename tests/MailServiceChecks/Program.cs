using System.Net;
using System.Net.Http.Json;
using System.Net.Mail;
using Api.Controllers;
using Core.Entities;
using Core.Entities.EmailModels;
using Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using Core.Interfaces;
using Infrastructure.Services;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Options;

var pickup = Path.Combine(Path.GetTempPath(), "starwatchr-mail-check-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(pickup);
var settings = new EmailSettings
{
    FromEmail = "sender@example.test",
    ToEmail = "owner@example.test"
};
var sender = new PickupEmailService(Options.Create(settings), pickup);
var key = new string('x', 40);
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
{
    ["NotificationDelivery:ApiKey"] = key
});
builder.Logging.ClearProviders();
builder.Services.AddSingleton<IEmailService>(sender);
builder.Services.AddDbContext<SWDbContext>(options =>
    options.UseSqlite($"Data Source={Path.Combine(pickup, "metrics-test.db")}"));
builder.Services.AddControllers().AddApplicationPart(typeof(NotificationMailController).Assembly);
await using var app = builder.Build();
app.MapControllers();
using (var scope = app.Services.CreateScope())
{
    var database = scope.ServiceProvider.GetRequiredService<SWDbContext>();
    await database.Database.EnsureCreatedAsync();
    var current = new PageView("recent-browser", DateOnly.FromDateTime(DateTime.UtcNow), "/moon");
    var old = new PageView("old-browser", DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-200)), "/");
    database.PageViews.AddRange(current, old);
    database.Entry(old).Property(p => p.CreatedAt).CurrentValue = DateTime.UtcNow.AddDays(-200);
    await database.SaveChangesAsync();
}
await app.StartAsync();

var address = app.Services.GetRequiredService<IServer>()
    .Features.Get<IServerAddressesFeature>()!.Addresses.Single();
using var client = new HttpClient { BaseAddress = new Uri(address) };
var message = new NotificationEmail
{
    DeliveryId = new string('a', 64),
    ToEmail = "subscriber@example.test",
    Subject = "Observing evening",
    Text = "Your observing window is 21:00 to 23:00.",
    Html = "<h1>Your observing evening</h1>",
    UnsubscribeUrl = "https://example.test/api/unsubscribe?token=test"
};

var denied = await client.PostAsJsonAsync("/internal/notification-mail", message);
Check(denied.StatusCode == HttpStatusCode.Unauthorized, "Reject unauthenticated delivery");
var coldDenied = await client.GetAsync("/internal/notification-mail/ready");
Check(coldDenied.StatusCode == HttpStatusCode.Unauthorized, "Readiness requires the relay key");
client.DefaultRequestHeaders.Add("X-Notification-Key", key);
var ready = await client.GetAsync("/internal/notification-mail/ready");
Check(ready.StatusCode == HttpStatusCode.NoContent, "Authenticated readiness returns 204");
Check(Directory.GetFiles(pickup, "*.eml").Length == 0, "Readiness sends no email");
var accepted = await client.PostAsJsonAsync("/internal/notification-mail", message);
Check(accepted.IsSuccessStatusCode, "Authenticated delivery reaches the existing EmailService");
var notification = File.ReadAllText(Directory.GetFiles(pickup, "*.eml").Single());
Check(notification.Contains("To: subscriber@example.test"), "Notification uses subscriber address");
Check(!notification.Contains("To: owner@example.test"), "Notification does not use contact recipient");
Check(notification.Contains("text/plain") && notification.Contains("text/html"), "Plain text and HTML alternatives");
Check(notification.Contains("List-Unsubscribe-Post: List-Unsubscribe=One-Click"), "One-click unsubscribe header");
Check(notification.Contains($"<{message.DeliveryId}@example.test>"), "Stable SMTP message ID");

var before = Directory.GetFiles(pickup, "*.eml").ToHashSet();
await sender.SendEmailAsync("Contact message", "Contact body");
var contact = File.ReadAllText(Directory.GetFiles(pickup, "*.eml").Single(file => !before.Contains(file)));
Check(contact.Contains("To: owner@example.test"), "Contact mail retains configured ToEmail");
message.ToEmail = "invalid-address";
var invalid = await client.PostAsJsonAsync("/internal/notification-mail", message);
Check(invalid.StatusCode == HttpStatusCode.BadRequest, "Invalid recipient rejected before SMTP");
var recentViews = await client.GetFromJsonAsync<JsonElement>("/metrics/pageviews?days=181");
Check(recentViews.GetArrayLength() == 1, "Traffic date window excludes older records");
Check(recentViews[0].GetProperty("day").GetString()!.EndsWith("Z"), "Traffic timestamps explicitly use UTC");
var allViews = await client.GetFromJsonAsync<JsonElement>("/metrics/pageviews");
Check(allViews.GetArrayLength() == 2, "Existing unfiltered traffic endpoint remains compatible");
var invalidWindow = await client.GetAsync("/metrics/pageviews?days=0");
Check(invalidWindow.StatusCode == HttpStatusCode.BadRequest, "Invalid traffic date window rejected");
await app.StopAsync();
Console.WriteLine("16 API integration checks passed; isolated database and local email capture only.");

static void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException(description);
    Console.WriteLine("PASS " + description);
}

sealed class PickupEmailService(IOptions<EmailSettings> settings, string directory) : EmailService(settings)
{
    protected override SmtpClient CreateClient() => new()
    {
        DeliveryMethod = SmtpDeliveryMethod.SpecifiedPickupDirectory,
        PickupDirectoryLocation = directory,
        EnableSsl = false
    };
}

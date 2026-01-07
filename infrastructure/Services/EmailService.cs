using System.Net;
using System.Net.Mail;
using Core.Entities.EmailModels;
using Core.Interfaces;
using Microsoft.Extensions.Options;

namespace Infrastructure.Services
{
    public class EmailService : IEmailService
    {
        private readonly EmailSettings _emailSettings;

        public EmailService(IOptions<EmailSettings> emailSettings)
        {
            _emailSettings = emailSettings.Value;
        }

        public async Task SendEmailAsync(string subject, string body)
        {
            using (var client = new SmtpClient(_emailSettings.SmtpServer, _emailSettings.SmtpPort))
            {
                client.Credentials = new NetworkCredential(_emailSettings.FromEmail, _emailSettings.Password);
                client.EnableSsl = true;

                var mailMessage = new MailMessage(_emailSettings.FromEmail, _emailSettings.ToEmail, subject, body);
                await client.SendMailAsync(mailMessage);
            }
        }
    }
}

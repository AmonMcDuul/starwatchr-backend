using Core.Entities.EmailModels;

namespace Core.Interfaces;

public interface IEmailService
{
    Task SendEmailAsync(string subject, string body);
    Task SendNotificationAsync(NotificationEmail email, CancellationToken cancellationToken = default);
}

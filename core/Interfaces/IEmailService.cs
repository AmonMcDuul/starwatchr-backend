namespace Core.Interfaces
{
    public interface IEmailService
    {
        Task SendEmailAsync(string subject, string body);
    }
}

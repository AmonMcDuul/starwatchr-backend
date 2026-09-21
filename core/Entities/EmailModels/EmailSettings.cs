namespace Core.Entities.EmailModels;

public class EmailSettings
{
    public string SmtpServer { get; set; } = string.Empty;
    public int SmtpPort { get; set; } = 587;
    public string FromEmail { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public string ToEmail { get; set; } = string.Empty;
}

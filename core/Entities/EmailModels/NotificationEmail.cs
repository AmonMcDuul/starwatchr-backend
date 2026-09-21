using System.ComponentModel.DataAnnotations;

namespace Core.Entities.EmailModels;

public sealed class NotificationEmail
{
    [Required, RegularExpression("^[a-f0-9]{64}$")]
    public string DeliveryId { get; set; } = string.Empty;

    [Required, EmailAddress, StringLength(254)]
    public string ToEmail { get; set; } = string.Empty;

    [Required, StringLength(500)]
    public string Subject { get; set; } = string.Empty;

    [Required, StringLength(100000)]
    public string Text { get; set; } = string.Empty;

    [Required, StringLength(200000)]
    public string Html { get; set; } = string.Empty;

    [StringLength(4000)]
    public string? UnsubscribeUrl { get; set; }
}

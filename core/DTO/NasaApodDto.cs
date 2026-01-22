namespace Core.DTO
{
    public class NasaApodDto
    {
        public string Date { get; set; } = null!;
        public string Title { get; set; } = null!;
        public string Explanation { get; set; } = null!;
        public string Media_Type { get; set; } = null!;
        public string? Url { get; set; } = null!;
        public string? Hdurl { get; set; }
        public string? Copyright { get; set; }
    }
}

using Microsoft.AspNetCore.Mvc.Formatters;

namespace Api.DTO
{
    public class NasaApodViewModel
    {
        public DateOnly Date { get; set; }
        public string Title { get; set; }
        public string Explanation { get; set; }
        public string MediaType { get; set; }
        public string? Url { get; set; }
        public string? Hdurl { get; set; }
        public string? Copyright { get; set; }

        public NasaApodViewModel(DateOnly date, string title, string explanation, string mediaType, string? url, string? hdUrl, string? copyright)
        {
            Date = date;
            Title = title;
            Explanation = explanation;
            MediaType = mediaType;
            Url = url;
            Hdurl = hdUrl;
            Copyright = copyright;
        }
    }

}

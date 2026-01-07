using Core.Entities.Common;

namespace Core.Entities
{
    public class Apod : BaseEntity
    {
        public DateOnly Date { get; private set; }

        public string Title { get; private set; }
        public string Explanation { get; private set; }
        public string MediaType { get; private set; }

        public string Url { get; private set; }
        public string? HdUrl { get; private set; }

        private Apod() { }

        public Apod(DateOnly date, string title, string explanation, string mediaType, string url, string? hdUrl)
        {
            Date = date;
            Title = title;
            Explanation = explanation;
            MediaType = mediaType;
            Url = url;
            HdUrl = hdUrl;
        }
    }
}

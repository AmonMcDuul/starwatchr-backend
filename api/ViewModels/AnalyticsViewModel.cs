namespace Api.ViewModels
{
    public class PageViewModel
    {
        public string UserSeed { get; set; } = "";
        public DateOnly Day { get; set; }
        public string Path { get; set; } = "";
    }

    public record PageViewDto(
        string UserSeed,
        DateOnly Day,
        string Path
    );

    public record AnalyticsSummaryDto(
        DateOnly Day,
        int PageViews,
        int UniqueVisitors
    );
}

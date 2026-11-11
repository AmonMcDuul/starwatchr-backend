using Core.Entities;
using Core.Interfaces;
using Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Infrastructure.Services
{
    /// <summary>
    /// NASA moved APOD to science.nasa.gov. The old api.nasa.gov/planetary/apod endpoint now
    /// answers with the NASA logo (or a 500), so the daily picture is read from the public
    /// WordPress feed of science.nasa.gov instead.
    /// </summary>
    public class NasaApodService : INasaApodService
    {
        private const string LatestApodUrl =
            "https://science.nasa.gov/wp-json/wp/v2/image-article?search=APOD&per_page=5&orderby=date&order=desc&_embed=wp:featuredmedia";
        private const string LogoMarker = "nasa-logo";
        private static readonly TimeSpan RetryInterval = TimeSpan.FromMinutes(20);
        private static readonly TimeZoneInfo Eastern =
            TimeZoneInfo.TryFindSystemTimeZoneById("America/New_York", out var zone)
                ? zone
                : TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
        private static readonly object AttemptLock = new();
        private static DateTime _lastAttemptUtc = DateTime.MinValue;

        private readonly HttpClient _http;
        private readonly SWDbContext _db;

        public NasaApodService(HttpClient http, SWDbContext db)
        {
            _http = http;
            _db = db;
        }

        public async Task<Apod?> GetTodayAsync()
        {
            // APOD publishes on US Eastern dates.
            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, Eastern));

            var latestGood = await _db.Apods
                .AsNoTracking()
                .Where(a => a.Url != "" && !a.Url.Contains(LogoMarker))
                .OrderByDescending(a => a.Date)
                .FirstOrDefaultAsync();

            if (latestGood != null && latestGood.Date >= today)
            {
                return latestGood;
            }

            // Before NASA publishes today's picture, avoid asking again on every page view.
            if (latestGood != null && !ShouldAttemptFetch())
            {
                return latestGood;
            }

            var fresh = await FetchLatestAsync();
            if (fresh == null)
            {
                return latestGood;
            }

            if (!await _db.Apods.AnyAsync(a => a.Date == fresh.Date && !a.Url.Contains(LogoMarker)))
            {
                _db.Apods.Add(fresh);
                await _db.SaveChangesAsync();
            }

            return fresh;
        }

        private static bool ShouldAttemptFetch()
        {
            lock (AttemptLock)
            {
                if (DateTime.UtcNow - _lastAttemptUtc < RetryInterval)
                {
                    return false;
                }

                _lastAttemptUtc = DateTime.UtcNow;
                return true;
            }
        }

        private async Task<Apod?> FetchLatestAsync()
        {
            try
            {
                var posts = await _http.GetFromJsonAsync<List<WpPost>>(LatestApodUrl);
                var post = posts?
                    .Where(p => p.Slug.StartsWith("apod-", StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(p => p.Date)
                    .FirstOrDefault();
                if (post == null)
                {
                    return null;
                }

                var media = post.Embedded?.FeaturedMedia?.FirstOrDefault();
                var imageUrl = media?.SourceUrl;
                if (string.IsNullOrWhiteSpace(imageUrl) || imageUrl.Contains(LogoMarker))
                {
                    return null;
                }

                // "APOD: 2026 November 11 – NGC 4449: Small Galaxy, Big Impact" -> "NGC 4449: Small Galaxy, Big Impact"
                var title = Regex.Replace(
                    WebUtility.HtmlDecode(post.Title.Rendered),
                    @"^APOD:\s*\d{4}\s+\w+\s+\d{1,2}\s*[–-]\s*",
                    "").Trim();

                var match = Regex.Match(
                    post.Content?.Rendered ?? "",
                    "media-detail-hero__description[^>]*>(.*?)</p>",
                    RegexOptions.Singleline);
                var raw = match.Success ? match.Groups[1].Value : post.Excerpt?.Rendered ?? "";
                var text = WebUtility.HtmlDecode(Regex.Replace(raw, "<.*?>", ""));
                var explanation = Regex.Replace(Regex.Replace(text, @"\s+", " ").Trim(), @"^Explanation:\s*", "");

                var credits = string.IsNullOrWhiteSpace(media?.Credits)
                    ? null
                    : WebUtility.HtmlDecode(Regex.Replace(media.Credits, "<.*?>", "")).Trim();

                return new Apod(
                    DateOnly.FromDateTime(post.Date),
                    title,
                    explanation,
                    "image",
                    imageUrl,
                    null,
                    credits);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or NotSupportedException)
            {
                return null;
            }
        }

        private sealed record WpRendered(string Rendered);

        private sealed record WpMedia(
            [property: JsonPropertyName("source_url")] string? SourceUrl,
            string? Credits);

        private sealed record WpEmbedded(
            [property: JsonPropertyName("wp:featuredmedia")] List<WpMedia>? FeaturedMedia);

        private sealed record WpPost(
            DateTime Date,
            string Slug,
            WpRendered Title,
            WpRendered? Content,
            WpRendered? Excerpt,
            [property: JsonPropertyName("_embedded")] WpEmbedded? Embedded);
    }
}

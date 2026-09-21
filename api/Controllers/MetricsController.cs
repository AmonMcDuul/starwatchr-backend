using System.ComponentModel.DataAnnotations;
using Api.ViewModels;
using Core.Entities;
using Infrastructure.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Controllers
{
    [ApiController]
    [Route("[controller]")]
    public class MetricsController : ControllerBase
    {
        private readonly SWDbContext _context;

        public MetricsController(SWDbContext context)
        {
            _context = context;
        }


        [HttpGet("pageviews")]
        public async Task<IEnumerable<PageViewDto>> GetPageViews(
            [FromQuery, Range(1, 366)] int? days = null)
        {
            var query = _context.PageViews.AsNoTracking();
            if (days is not null)
            {
                var since = DateTime.UtcNow.AddDays(-days.Value);
                query = query.Where(p => p.CreatedAt >= since);
            }

            return await query
                .OrderByDescending(p => p.CreatedAt)
                .Select(p => new PageViewDto(
                    p.UserSeed,
                    DateTime.SpecifyKind(p.CreatedAt, DateTimeKind.Utc),
                    p.Path
                ))
                .ToListAsync();
        }

        [HttpGet("summary")]
        public async Task<IEnumerable<AnalyticsSummaryDto>> GetSummary()
        {
            return await _context.PageViews
                .GroupBy(p => p.Day)
                .OrderByDescending(g => g.Key)
                .Select(g => new AnalyticsSummaryDto(
                    g.Key,
                    g.Count(),
                    g.Select(x => x.UserSeed).Distinct().Count()
                ))
                .ToListAsync();
        }

        [HttpPost("pageview")]
        public async Task<IActionResult> Track(PageViewModel model)
        {
            PageView newPageView = new(model.UserSeed, model.Day, model.Path);
            await _context.PageViews.AddAsync(newPageView);
            await _context.SaveChangesAsync();
            return Ok();
        }
    }
}

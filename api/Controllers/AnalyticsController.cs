using Api.ViewModels;
using Core.Entities;
using Infrastructure.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Controllers
{
    [ApiController]
    [Route("[controller]")]
    public class AnalyticsController : ControllerBase
    {
        private readonly SWDbContext _context;

        public AnalyticsController(SWDbContext context)
        {
            _context = context;
        }


        [HttpGet("pageviews")]
        public async Task<IEnumerable<PageViewDto>> GetPageViews()
        {
            return await _context.PageViews
                .OrderByDescending(p => p.Day)
                .Select(p => new PageViewDto(
                    p.UserSeed,
                    p.Day,
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
            PageView newPageView =new (model.UserSeed, model.Day, model.Path);
            await _context.PageViews.AddAsync(newPageView);
            await _context.SaveChangesAsync();
            return Ok();
        }
    }
}

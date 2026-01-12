using Api.DTO;
using Core.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace Api.Controllers
{
    [ApiController]
    [Route("api/apod")]
    public class NasaApodController : ControllerBase
    {
        private readonly INasaApodService _apodService;

        public NasaApodController(INasaApodService apodService)
        {
            _apodService = apodService;
        }

        [HttpGet("today")]
        public async Task<ActionResult<NasaApodViewModel>> GetToday()
        {
            var apod = await _apodService.GetTodayAsync();

            if (apod == null)
            {
                return NotFound();
            }

            return Ok(new NasaApodViewModel(apod.Date, apod.Title, apod.Explanation, apod.MediaType, apod.Url,  apod.HdUrl, apod.Copyright));
        }
    }

}

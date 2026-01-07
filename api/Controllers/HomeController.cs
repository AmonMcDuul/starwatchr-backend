using Microsoft.AspNetCore.Mvc;

namespace api.Controllers
{
    [ApiController]
    [Route("[controller]")]
    public class HomeController : ControllerBase
    {
        public HomeController() { }

        [HttpGet("")]
        public async Task<IActionResult> Test()
        {
            return Ok("yeah");
        }
    }
}

using Core.DTO;
using Core.Entities;
using Core.Interfaces;
using Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using System.Net.Http.Json;

namespace Infrastructure.Services
{
    public class NasaApodService : INasaApodService
    {
        private readonly HttpClient _http;
        private readonly SWDbContext _db;
        private readonly IConfiguration _config;

        public NasaApodService(
            HttpClient http,
            SWDbContext db,
            IConfiguration config)
        {
            _http = http;
            _db = db;
            _config = config;
        }

        public async Task<Apod?> GetTodayAsync()
        {
            var today = DateOnly.FromDateTime(DateTime.UtcNow);

            var existing = await _db.Apods
                .FirstOrDefaultAsync(a => a.Date == today);

            if (existing != null)
            {
                return existing;
            }

            var apiKey = _config["Nasa:ApiKey"];

            var dto = await _http.GetFromJsonAsync<NasaApodDto>(
                $"https://api.nasa.gov/planetary/apod?api_key={apiKey}");

            if (dto == null)
            {
                //return a default
                var def = new Apod(new DateOnly(2023, 10, 12), "The Pillars of Creation", "Stars are forming deep within the iconic Pillars of Creation. This image from the James Webb Space Telescope reveals stunning detail in a region of space filled with gas, dust and cosmic light.", "image", "https://apod.nasa.gov/apod/image/2210/stsci-pillarsofcreation.png", null, "NASA / ESA / CSA / STScI");
                return def;
            }

            var apod = new Apod(today, dto.Title, dto.Explanation, dto.Media_Type, dto.Url, dto.Hdurl, dto.Copyright);

            _db.Apods.Add(apod);
            await _db.SaveChangesAsync();

            return apod;
        }
    }

}

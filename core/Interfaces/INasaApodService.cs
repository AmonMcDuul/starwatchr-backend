using Core.Entities;

namespace Core.Interfaces
{
    public interface INasaApodService
    {
        Task<Apod?> GetTodayAsync();
    }
}

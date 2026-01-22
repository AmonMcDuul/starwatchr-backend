using Core.Entities.Common;

namespace Core.Entities
{
    public class PageView : BaseEntity
    {
        public string UserSeed { get; private set; } = null!;
        public DateOnly Day { get; private set; }
        public string Path { get; private set; } = null!;
        public PageView(string userSeed, DateOnly day, string path)
        {
            UserSeed = userSeed;
            Day = day;
            Path = path;
        }
    }
}

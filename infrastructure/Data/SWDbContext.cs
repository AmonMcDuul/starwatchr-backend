using Core.Entities;
using Core.Entities.Common;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Data
{
    public class SWDbContext : DbContext
    {
        public DbSet<Apod> Apods { get; set; }
        public DbSet<PageView> PageViews { get; set; }

        public SWDbContext(DbContextOptions<SWDbContext> options) : base(options) { }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
        }

        /// <summary>
        /// Save all changes that are being  tracked
        /// </summary>
        /// <returns>Integer</returns>
        public override int SaveChanges()
        {
            // call BaseEntity.SetUpdated for every modified entity
            var entities = ChangeTracker.Entries();

            foreach (var entity in entities)
            {
                if (entity.State == EntityState.Modified)
                {
                    var currentEntity = (BaseEntity)entity.Entity;
                    currentEntity.SetUpdated();
                }
            }

            return base.SaveChanges();
        }

        /// <summary>
        /// Save changes asynchronously
        /// </summary>
        /// <param name="cancellationToken">Cancellation token of type CancellationToken</param>
        /// <returns>Task of type int</returns>
        public override async Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
        {
            return await base.SaveChangesAsync(cancellationToken);
        }
    }
}

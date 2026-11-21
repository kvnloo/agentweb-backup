## ENG-3141: Partner Portal stops linking four placeholder marketing pages (2026-11-18)

- `/marketing/social-listening`, `/marketing/creative-generation`, `/marketing/report/:id` and `/marketing/blog` now redirect to `/marketing` instead of rendering Not Found or a bare placeholder.
- The two "Coming Soon" cards on the marketing home no longer carry a "Learn More" link to those pages.
- Route catalog marks the four as `redirect`; new catalog tests assert no viewer's header navigation offers a placeholder or dead-end destination.

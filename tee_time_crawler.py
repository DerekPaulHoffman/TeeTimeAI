import asyncio
import json
from datetime import datetime
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode

async def update_course_booking_urls():
    # Read existing courses
    try:
        with open('golf_courses.json', 'r') as f:
            courses = json.load(f)
    except FileNotFoundError:
        print("No existing golf_courses.json found.")
        return

    async with AsyncWebCrawler(config=BrowserConfig(headless=False)) as crawler:
        # Update each course
        for course in courses:
            if not course['url']:  # Skip if no URL provided
                continue
                
            print(f"\nProcessing {course['url']}...")
            result = await crawler.arun(
                url=course['url'],
                config=CrawlerRunConfig(
                    verbose=True
                )
            )
            
            if result.success:
                if hasattr(result, 'links') and result.links:
                    internal_links = result.links.get('internal', [])
                    external_links = result.links.get('external', [])
                    all_links = internal_links + external_links
                    
                    # Find the booking URL
                    for link in all_links:
                        if 'foreup' in link['href'].lower() and 'booking' in link['href'].lower():
                            course['booking_url'] = link['href']
                            break
                    
                    # Update last_updated timestamp
                    course['last_updated'] = datetime.now().isoformat()
            else:
                print(f"Failed to process {course['url']}")

        # Save updated data
        with open('golf_courses.json', 'w') as f:
            json.dump(courses, f, indent=2)
        
        print("\nUpdated golf_courses.json:")
        print(json.dumps(courses, indent=2))

if __name__ == "__main__":
    asyncio.run(update_course_booking_urls())
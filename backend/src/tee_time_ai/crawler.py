"""
Crawler module for TeeTimeAI.
Handles web crawling and data extraction for golf course booking URLs.
"""

import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode

class GolfCourseCrawler:
    """Handles crawling and updating golf course booking URLs."""
    
    def __init__(self, data_file: str = None):
        """
        Initialize the crawler.
        
        Args:
            data_file: Path to the JSON file containing golf course data
        """
        if data_file is None:
            # Use the default path in the package directory
            package_dir = Path(__file__).parent
            self.data_file = package_dir / "golf_courses.json"
        else:
            self.data_file = Path(data_file)
        
    async def update_course_booking_urls(self) -> None:
        """Update booking URLs for all golf courses in the data file."""
        courses = self._load_courses()
        if not courses:
            return
            
        async with AsyncWebCrawler(config=BrowserConfig(headless=False)) as crawler:
            for course in courses:
                if not course.get('url'):  # Skip if no URL provided
                    continue
                    
                print(f"\nProcessing {course['url']}...")
                await self._process_course(crawler, course)
                
        self._save_courses(courses)
        print("\nUpdated golf_courses.json:")
        print(json.dumps(courses, indent=2))
        
    def _load_courses(self) -> List[Dict]:
        """Load golf courses from the JSON file."""
        try:
            with open(self.data_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            print(f"No existing {self.data_file} found.")
            return []
            
    def _save_courses(self, courses: List[Dict]) -> None:
        """Save golf courses to the JSON file."""
        with open(self.data_file, 'w') as f:
            json.dump(courses, f, indent=2)
            
    async def _process_course(self, crawler: AsyncWebCrawler, course: Dict) -> None:
        """Process a single golf course to find its booking URL."""
        result = await crawler.arun(
            url=course['url'],
            config=CrawlerRunConfig(verbose=True)
        )
        
        if not result.success:
            print(f"Failed to process {course['url']}")
            return
            
        if hasattr(result, 'links') and result.links:
            internal_links = result.links.get('internal', [])
            external_links = result.links.get('external', [])
            all_links = internal_links + external_links
            
            for link in all_links:
                if 'foreup' in link['href'].lower() and 'booking' in link['href'].lower():
                    course['booking_url'] = link['href']
                    break
                    
            course['last_updated'] = datetime.now().isoformat()

def main():
    """Main entry point for the crawler."""
    crawler = GolfCourseCrawler()
    asyncio.run(crawler.update_course_booking_urls())

if __name__ == "__main__":
    main() 
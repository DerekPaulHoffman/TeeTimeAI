"""
Crawler module for TeeTimeAI.
Handles web crawling and data extraction for golf course booking URLs and tee times.
"""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode, LLMConfig
from crawl4ai.extraction_strategy import LLMExtractionStrategy

# Load environment variables from .env file
load_dotenv()

# Debug: Check if API key is loaded
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    raise ValueError("OPENAI_API_KEY not found in environment variables")
print("OpenAI API key loaded successfully")

class TeeTime(BaseModel):
    """Model for extracted tee time information."""
    time: str = Field(..., description="The tee time in HH:MM format")
    date: str = Field(..., description="The date of the tee time in YYYY-MM-DD format")
    available: bool = Field(..., description="Whether the tee time is available for booking")
    price: Optional[str] = Field(None, description="The price for the tee time if available")
    players: Optional[int] = Field(None, description="Number of players allowed for this tee time")

class TeeTimeExtraction(BaseModel):
    """Model for the overall tee time extraction result."""
    course_name: str = Field(..., description="Name of the golf course")
    booking_url: Optional[str] = Field(None, description="URL for booking tee times")
    tee_times: List[TeeTime] = Field(default_factory=list, description="List of available tee times")
    last_updated: str = Field(..., description="ISO timestamp of when this data was extracted")

class GolfCourseCrawler:
    """Handles crawling and updating golf course booking URLs and tee times."""
    
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
        """Update booking URLs and tee times for all golf courses in the data file."""
        courses = self._load_courses()
        if not courses:
            return
            
        # Configure the LLM extraction strategy
        llm_strategy = LLMExtractionStrategy(
            llm_config=LLMConfig(
                provider="openai/gpt-4",
                api_token=os.getenv("OPENAI_API_KEY")
            ),
            schema=TeeTimeExtraction.model_json_schema(),
            extraction_type="schema",
            instruction="""Extract tee time information from the golf course website. 
            Look for available tee times, their dates, times, prices, and booking URLs.
            Focus on finding the main booking URL (often containing 'foreup' or 'teeitup').
            Return the data in a structured format matching the schema.""",
            chunk_token_threshold=2000,
            overlap_rate=0.1,
            apply_chunking=True,
            input_format="html",
            extra_args={"temperature": 0.1, "max_tokens": 1500}
        )

        # Configure the crawler
        crawl_config = CrawlerRunConfig(
            extraction_strategy=llm_strategy,
            cache_mode=CacheMode.BYPASS
        )
            
        async with AsyncWebCrawler(config=BrowserConfig(headless=True)) as crawler:
            for course in courses:
                if not course.get('url'):
                    continue
                    
                print(f"\nProcessing {course['url']}...")
                await self._process_course(crawler, course, crawl_config)
                
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
            
    async def _process_course(self, crawler: AsyncWebCrawler, course: Dict, crawl_config: CrawlerRunConfig) -> None:
        """Process a single golf course to find its booking URL and tee times."""
        result = await crawler.arun(
            url=course['url'],
            config=crawl_config
        )
        
        if not result.success:
            print(f"Failed to process {course['url']}")
            return
            
        try:
            # Parse the extracted content
            extracted_data = json.loads(result.extracted_content)
            
            # Update the course data
            if isinstance(extracted_data, dict):
                course['booking_url'] = extracted_data.get('booking_url')
                course['tee_times'] = extracted_data.get('tee_times', [])
                course['last_updated'] = datetime.now().isoformat()
                
                print(f"Found {len(course['tee_times'])} tee times!")
            else:
                print("Unexpected data format from LLM extraction")
            
        except json.JSONDecodeError:
            print("Failed to parse extracted content as JSON")
        except Exception as e:
            print(f"Error processing extracted content: {e}")

def main():
    """Main entry point for the crawler."""
    crawler = GolfCourseCrawler()
    asyncio.run(crawler.update_course_booking_urls())

if __name__ == "__main__":
    main() 
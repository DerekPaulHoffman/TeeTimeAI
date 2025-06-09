"""
Crawler module for TeeTimeAI.
Handles web crawling to find booking URLs for golf courses.
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
from playwright.async_api import Page, BrowserContext

# Load environment variables from .env file
load_dotenv()

# Debug: Check if API key is loaded
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    raise ValueError("OPENAI_API_KEY not found in environment variables")
print("OpenAI API key loaded successfully")

class BookingURLExtraction(BaseModel):
    """Model for extracting booking URL information."""
    course_name: str = Field(..., description="Name of the golf course")
    booking_url: Optional[str] = Field(None, description="URL for booking tee times")
    last_updated: str = Field(..., description="ISO timestamp of when this data was extracted")

class GolfCourseCrawler:
    """Handles crawling to find booking URLs for golf courses."""
    
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
        
    async def update_course_booking_urls(self, use_llm: bool = False) -> None:
        """Update booking URLs for all golf courses in the data file."""
        print("\n[DEBUG] Starting update_course_booking_urls")
        print(f"[DEBUG] Using LLM extraction: {use_llm}")
        courses = self._load_courses()
        if not courses:
            print("[DEBUG] No courses loaded. Exiting.")
            return
            
        # Configure the LLM extraction strategy only if needed
        crawl_config = None
        if use_llm:
            print("[DEBUG] Configuring LLM extraction strategy...")
            llm_strategy = LLMExtractionStrategy(
                llm_config=LLMConfig(
                    provider="openai",
                    model="gpt-3.5-turbo",
                    api_token=os.getenv("OPENAI_API_KEY")
                ),
                schema=BookingURLExtraction.model_json_schema(),
                extraction_type="schema",
                instruction="""Extract golf course booking information. Look for:
                1. Course name
                2. Booking URL (look for 'foreup', 'teeitup', 'book', 'reserve', 'tee time')
                
                Be concise. If you can't find a booking URL, return null for booking_url.
                Focus only on finding the booking URL.""",
                chunk_token_threshold=500,
                overlap_rate=0.05,
                apply_chunking=True,
                input_format="html",
                extra_args={
                    "temperature": 0.1, 
                    "max_tokens": 200,
                    "timeout": 30
                }
            )

            # Configure the crawler
            crawl_config = CrawlerRunConfig(
                extraction_strategy=llm_strategy,
                cache_mode=CacheMode.BYPASS
            )
        else:
            print("[DEBUG] Using simple extraction (no LLM)")
            
        print("[DEBUG] Starting crawl...")
        async with AsyncWebCrawler(config=BrowserConfig(
            headless=False
        )) as crawler:
            for course in courses:
                if not course.get('url'):
                    print(f"[DEBUG] Skipping course with missing URL: {course}")
                    continue
                    
                print(f"\n[DEBUG] Processing course: {course['url']}")
                
                try:
                    if use_llm:
                        await self._process_course_llm(crawler, course, crawl_config)
                    else:
                        await self._process_course_simple(crawler, course)
                except Exception as e:
                    if 'rate limit' in str(e).lower():
                        print(f"[DEBUG] Rate limit error caught: {e}")
                        print("[DEBUG] Stopping execution due to rate limit")
                        return
                    else:
                        print(f"[DEBUG] Error processing course: {e}")
                        continue
                
                # Add a delay between courses for rate limiting
                print("[DEBUG] Waiting 3 seconds before next course...")
                await asyncio.sleep(3)
                
        print("[DEBUG] All courses processed.")
        
        self._save_courses(courses)
        print("\n[DEBUG] Updated golf_courses.json:")
        print(json.dumps(courses, indent=2))
        
    async def update_course_booking_urls_simple(self) -> None:
        """Update booking URLs using simple web scraping (no LLM at all)."""
        print("\n[DEBUG] Starting simple update_course_booking_urls (NO LLM)")
        courses = self._load_courses()
        if not courses:
            print("[DEBUG] No courses loaded. Exiting.")
            return
            
        print("[DEBUG] Using simple web scraping only")
        
        async with AsyncWebCrawler(config=BrowserConfig(
            headless=False
        )) as crawler:
            for course in courses:
                if not course.get('url'):
                    print(f"[DEBUG] Skipping course with missing URL: {course}")
                    continue
                    
                print(f"\n[DEBUG] Processing course: {course['url']}")
                await self._process_course_simple(crawler, course)
                
                # Add a delay between courses
                print("[DEBUG] Waiting 3 seconds before next course...")
                await asyncio.sleep(3)
                
        self._save_courses(courses)
        print("\n[DEBUG] Updated golf_courses.json:")
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
            
    async def _process_course_simple(self, crawler: AsyncWebCrawler, course: Dict) -> None:
        """Process a course with simple extraction to find booking URL."""
        url_to_crawl = course['url']
        print(f"[DEBUG] Simple crawling URL: {url_to_crawl}")
        
        try:
            result = await crawler.arun(
                url=url_to_crawl,
                config=CrawlerRunConfig(
                    extraction_strategy=None,  # No LLM extraction
                    cache_mode=CacheMode.BYPASS
                )
            )
            
            if result.success:
                print(f"[DEBUG] Simple crawl successful for {url_to_crawl}")
                
                # Extract basic info from URL
                course_name = url_to_crawl.split('//')[-1].split('/')[0].replace('www.', '')
                course['name'] = course_name.title().replace('-', ' ')
                course['last_updated'] = datetime.now().isoformat()
                
                # Check if the current URL is already a booking system
                if any(pattern in url_to_crawl.lower() for pattern in ['foreup', 'teeitup', 'book', 'reserve']):
                    course['booking_url'] = url_to_crawl
                    print(f"[DEBUG] Current URL is already a booking system: {url_to_crawl}")
                else:
                    # Look for booking links in the page content
                    html_content = result.extracted_content if hasattr(result, 'extracted_content') and result.extracted_content else ""
                    
                    if html_content:
                        # Look for common booking URL patterns
                        booking_patterns = [
                            'foreup.com',
                            'teeitup.golf',
                            'book',
                            'reserve',
                            'tee time',
                            'teetime'
                        ]
                        
                        # Simple text search for booking URLs
                        for pattern in booking_patterns:
                            if pattern in html_content.lower():
                                print(f"[DEBUG] Found booking pattern: {pattern}")
                                # For now, just note that we found a pattern
                                # In a full implementation, you'd extract the actual URL
                                course['booking_url'] = url_to_crawl  # Use current URL as fallback
                                break
                        else:
                            print("[DEBUG] No booking patterns found")
                            course['booking_url'] = None
                    else:
                        print("[DEBUG] No HTML content available")
                        course['booking_url'] = None
                    
            else:
                print(f"[DEBUG] Simple crawl failed for {url_to_crawl}")
                course['booking_url'] = None
                
        except Exception as e:
            print(f"[DEBUG] Error in simple crawl: {e}")
            course['booking_url'] = None
            
    async def _process_course_llm(self, crawler: AsyncWebCrawler, course: Dict, crawl_config: CrawlerRunConfig) -> None:
        """Process a single golf course to find its booking URL using LLM."""
        url_to_crawl = course['url']
        print(f"[DEBUG] LLM crawling URL: {url_to_crawl}")
        
        result = await crawler.arun(
            url=url_to_crawl,
            config=crawl_config
        )
        
        if not result.success:
            print(f"[DEBUG] Failed to process {url_to_crawl}")
            print(f"[DEBUG] Result success: {result.success}")
            print(f"[DEBUG] Result error: {getattr(result, 'error', 'No error field')}")
            
            # Check if it's a rate limit error and fail immediately
            if hasattr(result, 'error') and 'rate limit' in str(result.error).lower():
                print("[DEBUG] Rate limit error detected - failing immediately")
                raise Exception("Rate limit reached - stopping execution")
            return
            
        print(f"[DEBUG] Successfully crawled {url_to_crawl}")
        
        try:
            # Parse the extracted content
            print("[DEBUG] Attempting to parse extracted content as JSON...")
            extracted_data = json.loads(result.extracted_content)
            print(f"[DEBUG] Successfully parsed JSON. Type: {type(extracted_data)}")
            
            # Update the course data
            if isinstance(extracted_data, dict):
                # Extract course name from URL if not provided
                if not extracted_data.get('course_name'):
                    course_name = url_to_crawl.split('//')[-1].split('/')[0].replace('www.', '')
                    extracted_data['course_name'] = course_name.title().replace('-', ' ')
                
                course['name'] = extracted_data.get('course_name')
                course['booking_url'] = extracted_data.get('booking_url')
                course['last_updated'] = datetime.now().isoformat()
                
                print(f"[DEBUG] Course: {course['name']}")
                if course['booking_url']:
                    print(f"[DEBUG] Found booking URL: {course['booking_url']}")
                else:
                    print("[DEBUG] No booking URL found")
            else:
                print("[DEBUG] Unexpected data format from LLM extraction")
                # Set basic course info even if extraction failed
                course_name = url_to_crawl.split('//')[-1].split('/')[0].replace('www.', '')
                course['name'] = course_name.title().replace('-', ' ')
                course['booking_url'] = None
            
        except json.JSONDecodeError as e:
            print(f"[DEBUG] JSON Decode Error: {e}")
            print(f"[DEBUG] Failed to parse extracted content as JSON")
            # Set basic course info even if parsing failed
            course_name = url_to_crawl.split('//')[-1].split('/')[0].replace('www.', '')
            course['name'] = course_name.title().replace('-', ' ')
            course['booking_url'] = None
        except Exception as e:
            print(f"[DEBUG] Unexpected error during processing: {e}")
            # Set basic course info even if processing failed
            course_name = url_to_crawl.split('//')[-1].split('/')[0].replace('www.', '')
            course['name'] = course_name.title().replace('-', ' ')
            course['booking_url'] = None

    async def open_booking_page_with_login(self) -> None:
        """Open the booking page and handle login using Crawl4AI hooks."""
        print("\n[DEBUG] Opening booking page with login handling...")
        
        courses = self._load_courses()
        if not courses:
            print("[DEBUG] No courses loaded. Exiting.")
            return
            
        course = courses[0]  # Just use the first course
        booking_url = course.get('booking_url') or course['url']
        
        print(f"[DEBUG] Opening booking URL: {booking_url}")
        
        # Get credentials from environment variables
        username = os.getenv("GOLF_USERNAME")
        password = os.getenv("GOLF_PASSWORD")
        
        if not username or not password:
            print("[DEBUG] No golf credentials found in environment variables")
            print("[DEBUG] Set GOLF_USERNAME and GOLF_PASSWORD environment variables")
            print("[DEBUG] Proceeding without login...")
        
        # Create the crawler but don't use async context manager to keep it open
        crawler = AsyncWebCrawler(config=BrowserConfig(
            headless=False
        ))
        
        # Define the login hook
        async def on_page_context_created(page: Page, context: BrowserContext, **kwargs):
            """Handle login when a new page context is created."""
            print("[HOOK] on_page_context_created - Setting up page & context for login.")
            
            if username and password:
                print(f"[HOOK] Attempting login for user: {username}")
                
                try:
                    # Set viewport for better visibility
                    await page.set_viewport_size({"width": 1200, "height": 800})
                    
                    # Navigate to the booking page first
                    await page.goto(booking_url)
                    print(f"[HOOK] Navigated to: {booking_url}")
                    
                    # Wait for page to load
                    await page.wait_for_load_state("networkidle")
                    
                    # Look for login elements and attempt to fill them
                    login_selectors = [
                        'input[name="username"]',
                        'input[name="email"]', 
                        'input[type="email"]',
                        'input[id*="username"]',
                        'input[id*="email"]',
                        'input[placeholder*="email"]',
                        'input[placeholder*="username"]',
                        'input[placeholder*="Email"]',
                        'input[placeholder*="Username"]'
                    ]
                    
                    password_selectors = [
                        'input[name="password"]',
                        'input[type="password"]',
                        'input[id*="password"]',
                        'input[placeholder*="password"]',
                        'input[placeholder*="Password"]'
                    ]
                    
                    submit_selectors = [
                        'button[type="submit"]',
                        'input[type="submit"]',
                        'button:contains("Login")',
                        'button:contains("Sign In")',
                        'button:contains("Log In")',
                        'input[value*="Login"]',
                        'input[value*="Sign In"]',
                        'input[value*="Log In"]'
                    ]
                    
                    # Try to fill username field
                    username_filled = False
                    for selector in login_selectors:
                        try:
                            await page.wait_for_selector(selector, timeout=2000)
                            await page.fill(selector, username)
                            print(f"[HOOK] Filled username using selector: {selector}")
                            username_filled = True
                            break
                        except Exception as e:
                            print(f"[HOOK] Failed to fill username with {selector}: {e}")
                            continue
                    
                    if not username_filled:
                        print("[HOOK] Could not find username field")
                        return page
                    
                    # Try to fill password field
                    password_filled = False
                    for selector in password_selectors:
                        try:
                            await page.wait_for_selector(selector, timeout=2000)
                            await page.fill(selector, password)
                            print(f"[HOOK] Filled password using selector: {selector}")
                            password_filled = True
                            break
                        except Exception as e:
                            print(f"[HOOK] Failed to fill password with {selector}: {e}")
                            continue
                    
                    if not password_filled:
                        print("[HOOK] Could not find password field")
                        return page
                    
                    # Try to click submit button
                    submit_clicked = False
                    for selector in submit_selectors:
                        try:
                            await page.wait_for_selector(selector, timeout=2000)
                            await page.click(selector)
                            print(f"[HOOK] Clicked submit using selector: {selector}")
                            submit_clicked = True
                            break
                        except Exception as e:
                            print(f"[HOOK] Failed to click submit with {selector}: {e}")
                            continue
                    
                    if not submit_clicked:
                        print("[HOOK] Could not find submit button")
                        return page
                    
                    print("[HOOK] Login form submitted successfully")
                    
                    # Wait for page to load after login
                    print("[HOOK] Waiting for page to load after login...")
                    await asyncio.sleep(3)
                    
                    # Check if login was successful by looking for common success indicators
                    try:
                        # Look for elements that indicate successful login
                        success_indicators = [
                            '.dashboard',
                            '.welcome',
                            '.user-menu',
                            '.logout',
                            '.profile',
                            '[data-testid*="user"]',
                            '[class*="user"]',
                            '[id*="user"]'
                        ]
                        
                        for indicator in success_indicators:
                            try:
                                await page.wait_for_selector(indicator, timeout=1000)
                                print(f"[HOOK] Login successful! Found indicator: {indicator}")
                                break
                            except:
                                continue
                        else:
                            print("[HOOK] Login status unclear - continuing anyway")
                            
                    except Exception as e:
                        print(f"[HOOK] Error checking login status: {e}")
                    
                except Exception as e:
                    print(f"[HOOK] Error during login process: {e}")
            
            return page
        
        # Attach the login hook
        crawler.crawler_strategy.set_hook("on_page_context_created", on_page_context_created)
        
        try:
            # Start the crawler
            await crawler.start()
            
            # Run the crawler (the hook will handle login)
            result = await crawler.arun(
                url=booking_url,
                config=CrawlerRunConfig(
                    extraction_strategy=None,
                    cache_mode=CacheMode.BYPASS,
                    wait_for="body"
                )
            )
            
            if result.success:
                print(f"[DEBUG] Successfully opened: {booking_url}")
                print("[DEBUG] Browser will stay open for manual inspection...")
                print("[DEBUG] Press Ctrl+C to close the browser")
                
                # Keep browser open indefinitely
                while True:
                    await asyncio.sleep(10)
                    print("[DEBUG] Browser still open... (Ctrl+C to close)")
                    
            else:
                print(f"[DEBUG] Failed to open: {booking_url}")
                
        except KeyboardInterrupt:
            print("\n[DEBUG] User interrupted - closing browser")
        except Exception as e:
            print(f"[DEBUG] Error: {e}")
        finally:
            # Make sure to close the crawler
            await crawler.close()
                
        print("[DEBUG] Browser closed")

    async def open_booking_page_simple(self) -> None:
        """Simply open the booking page and keep browser open for manual inspection."""
        print("\n[DEBUG] Opening booking page for manual inspection...")
        
        courses = self._load_courses()
        if not courses:
            print("[DEBUG] No courses loaded. Exiting.")
            return
            
        course = courses[0]  # Just use the first course
        booking_url = course.get('booking_url') or course['url']
        
        print(f"[DEBUG] Opening booking URL: {booking_url}")
        
        # Create the crawler but don't use async context manager to keep it open
        crawler = AsyncWebCrawler(config=BrowserConfig(
            headless=False
        ))
        
        try:
            # Start the crawler
            await crawler.start()
            
            # Just open the page
            result = await crawler.arun(
                url=booking_url,
                config=CrawlerRunConfig(
                    extraction_strategy=None,
                    cache_mode=CacheMode.BYPASS
                )
            )
            
            if result.success:
                print(f"[DEBUG] Successfully opened: {booking_url}")
                print("[DEBUG] Browser will stay open for manual inspection...")
                print("[DEBUG] Press Ctrl+C to close the browser")
                
                # Keep browser open indefinitely
                while True:
                    await asyncio.sleep(10)
                    print("[DEBUG] Browser still open... (Ctrl+C to close)")
                    
            else:
                print(f"[DEBUG] Failed to open: {booking_url}")
                
        except KeyboardInterrupt:
            print("\n[DEBUG] User interrupted - closing browser")
        except Exception as e:
            print(f"[DEBUG] Error: {e}")
        finally:
            # Make sure to close the crawler
            await crawler.close()
                
        print("[DEBUG] Browser closed")

def main():
    """Main entry point for the crawler."""
    crawler = GolfCourseCrawler()
    asyncio.run(crawler.open_booking_page_with_login())

if __name__ == "__main__":
    main() 
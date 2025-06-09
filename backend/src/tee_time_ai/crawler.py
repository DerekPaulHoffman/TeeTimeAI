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

    async def _check_for_login_fields(self, page):
        """Check if login fields are present on the page."""
        print(f"[HOOK] Checking for login fields on URL: {page.url}")
        
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
        
        # Check for login fields
        for selector in login_selectors:
            try:
                element = await page.query_selector(selector)
                if element:
                    print(f"[HOOK] Found login field: {selector}")
                    return True
            except:
                continue
                
        # Check for password fields
        for selector in password_selectors:
            try:
                element = await page.query_selector(selector)
                if element:
                    print(f"[HOOK] Found password field: {selector}")
                    return True
            except:
                continue
        
        # Also check for common login form indicators
        form_indicators = [
            'form[action*="login"]',
            'form[action*="signin"]',
            'form[id*="login"]',
            'form[class*="login"]',
            'form[id*="signin"]',
            'form[class*="signin"]'
        ]
        
        for selector in form_indicators:
            try:
                element = await page.query_selector(selector)
                if element:
                    print(f"[HOOK] Found login form: {selector}")
                    return True
            except:
                continue
        
        print("[HOOK] No login fields found on current page")
        return False
        
    async def _perform_login(self, page, username, password, login_selectors, password_selectors):
        """Perform the actual login once fields are found."""
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
        
        # Fill username
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
            return False
            
        # Fill password
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
            return False
            
        # Submit form
        submit_clicked = False
        for selector in submit_selectors:
            try:
                if ':contains(' in selector:
                    # Handle text-based submit selectors
                    text_content = selector.split(':contains("')[1].split('")')[0]
                    elements = await page.query_selector_all('button, input[type="submit"]')
                    for element in elements:
                        try:
                            element_text = await element.text_content()
                            if element_text and text_content.lower() in element_text.lower():
                                await element.click()
                                print(f"[HOOK] Clicked submit button with text '{text_content}'")
                                submit_clicked = True
                                break
                        except:
                            continue
                    if submit_clicked:
                        break
                else:
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
            return False
            
        print("[HOOK] Login form submitted successfully")
        print("[HOOK] Waiting for page to load after login...")
        await asyncio.sleep(3)
        return True
        
    async def _recursive_login_search(self, page, username, password, max_depth=3, current_depth=0):
        """Recursively search for and click elements that might lead to a login form."""
        if current_depth >= max_depth:
            print(f"[HOOK] Max search depth ({max_depth}) reached, stopping recursive search")
            return False
            
        print(f"[HOOK] Recursive login search - depth {current_depth + 1}")
        
        # Common elements that might lead to login
        login_related_selectors = [
            'a[href*="login"]',
            'a[href*="signin"]',
            'a[href*="sign-in"]',
            'a[href*="log-in"]',
            'a[href*="foreup"]',
            'a[href*="teeitup"]',
            'a[href*="book"]',
            'a[href*="reserve"]',
            'a[href*="tee"]',
            'a[href*="teetime"]',
            'button:contains("Login")',
            'button:contains("Sign In")',
            'button:contains("Log In")',
            'button:contains("Book")',
            'button:contains("Reserve")',
            'a:contains("Login")',
            'a:contains("Sign In")',
            'a:contains("Log In")',
            'a:contains("Member Login")',
            'a:contains("Member Sign In")',
            'a:contains("Golfer Login")',
            'a:contains("Book Tee Time")',
            'a:contains("Reserve")',
            'a:contains("Book Now")',
            'a:contains("Tee Times")',
            'a:contains("Book Online")',
            '[class*="login"]',
            '[class*="signin"]',
            '[id*="login"]',
            '[id*="signin"]'
        ]
        
        # Try to find and click login-related elements
        for selector in login_related_selectors:
            try:
                # Use a more flexible approach for text-based selectors
                if ':contains(' in selector:
                    # Handle text-based selectors
                    text_content = selector.split(':contains("')[1].split('")')[0]
                    elements = await page.query_selector_all('a, button, span, div')
                    for element in elements:
                        try:
                            element_text = await element.text_content()
                            if element_text and text_content.lower() in element_text.lower():
                                print(f"[HOOK] Found element with text '{text_content}': {element_text}")
                                
                                # Get the current URL before clicking
                                current_url = page.url
                                print(f"[HOOK] Current URL before click: {current_url}")
                                
                                # Try to click with navigation handling
                                success = await self._click_with_navigation_handling(page, element, text_content)
                                if success:
                                    # Check if login fields appeared after clicking
                                    if await self._check_for_login_fields(page):
                                        print("[HOOK] Login fields found after clicking!")
                                        return await self._perform_login(page, username, password, 
                                                                       self._get_login_selectors(), 
                                                                       self._get_password_selectors())
                                    else:
                                        print("[HOOK] No login fields found, continuing search...")
                                        # Continue searching on the current page
                                        continue
                        except Exception as e:
                            print(f"[HOOK] Error with element '{text_content}': {e}")
                            continue
                else:
                    # Handle regular CSS selectors
                    try:
                        # Check if selector exists without waiting for visibility
                        element = await page.query_selector(selector)
                        if element:
                            print(f"[HOOK] Found login-related element: {selector}")
                            
                            # Get the current URL before clicking
                            current_url = page.url
                            print(f"[HOOK] Current URL before click: {current_url}")
                            
                            # Try to click with navigation handling
                            success = await self._click_with_navigation_handling(page, element, selector)
                            if success:
                                # Check if login fields appeared after clicking
                                if await self._check_for_login_fields(page):
                                    print("[HOOK] Login fields found after clicking!")
                                    return await self._perform_login(page, username, password,
                                                                   self._get_login_selectors(),
                                                                   self._get_password_selectors())
                                else:
                                    print("[HOOK] No login fields found, continuing search...")
                                    # Continue searching on the current page
                                    continue
                    except Exception as e:
                        print(f"[HOOK] Error with selector {selector}: {e}")
                        continue
            except Exception as e:
                print(f"[HOOK] Error with selector {selector}: {e}")
                continue
        
        print(f"[HOOK] No login-related elements found at depth {current_depth + 1}")
        return False
        
    async def _click_with_navigation_handling(self, page, element, element_desc):
        """Click an element and handle potential navigation."""
        try:
            # Get the current URL before clicking
            current_url = page.url
            
            # Set up a navigation listener
            navigation_occurred = False
            new_url = None
            
            def handle_navigation(url):
                nonlocal navigation_occurred, new_url
                navigation_occurred = True
                new_url = url
                print(f"[HOOK] Navigation detected to: {url}")
            
            # Listen for navigation events
            page.on('framenavigated', handle_navigation)
            
            try:
                # Try multiple approaches to click the element
                click_success = False
                
                # Approach 1: Try normal click with visibility check
                try:
                    await element.wait_for_element_state('visible', timeout=2000)
                    await element.wait_for_element_state('stable', timeout=2000)
                    await element.click()
                    print(f"[HOOK] Clicked element (visible): {element_desc}")
                    click_success = True
                except Exception as e:
                    print(f"[HOOK] Visible click failed: {e}")
                
                # Approach 2: If visible click failed, try force click
                if not click_success:
                    try:
                        await element.click(force=True)
                        print(f"[HOOK] Force clicked element: {element_desc}")
                        click_success = True
                    except Exception as e:
                        print(f"[HOOK] Force click failed: {e}")
                
                # Approach 3: If both failed, try JavaScript click
                if not click_success:
                    try:
                        await page.evaluate("(element) => element.click()", element)
                        print(f"[HOOK] JavaScript clicked element: {element_desc}")
                        click_success = True
                    except Exception as e:
                        print(f"[HOOK] JavaScript click failed: {e}")
                
                # Approach 4: If all failed, try getting href and navigating directly
                if not click_success:
                    try:
                        href = await element.get_attribute('href')
                        if href:
                            print(f"[HOOK] Navigating directly to href: {href}")
                            await page.goto(href, wait_until='networkidle', timeout=15000)
                            click_success = True
                    except Exception as e:
                        print(f"[HOOK] Direct navigation failed: {e}")
                
                if not click_success:
                    print(f"[HOOK] All click attempts failed for: {element_desc}")
                    return False
                
                # Wait a bit for any navigation to start
                await asyncio.sleep(2)
                
                # Check if navigation occurred
                if navigation_occurred and new_url:
                    print(f"[HOOK] Navigation occurred: {current_url} -> {new_url}")
                    # Wait for the new page to load
                    await page.wait_for_load_state("networkidle", timeout=15000)
                    await asyncio.sleep(3)
                    return True
                else:
                    # Check if URL changed even if no navigation event was caught
                    await asyncio.sleep(2)
                    if page.url != current_url:
                        print(f"[HOOK] URL changed: {current_url} -> {page.url}")
                        await page.wait_for_load_state("networkidle", timeout=15000)
                        await asyncio.sleep(3)
                        return True
                    else:
                        print(f"[HOOK] No navigation occurred for: {element_desc}")
                        return True  # Still return True as the click was successful
                        
            finally:
                # Remove the navigation listener
                page.remove_listener('framenavigated', handle_navigation)
                
        except Exception as e:
            print(f"[HOOK] Error clicking element {element_desc}: {e}")
            return False

    def _get_login_selectors(self):
        """Get login field selectors."""
        return [
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
        
    def _get_password_selectors(self):
        """Get password field selectors."""
        return [
            'input[name="password"]',
            'input[type="password"]',
            'input[id*="password"]',
            'input[placeholder*="password"]',
            'input[placeholder*="Password"]'
        ]

    async def find_booking_url_and_login(self) -> None:
        """New recursive flow: find booking URL, click, check for tee times, login if needed, or try more links (max 5)."""
        print("\n[DEBUG] Starting new recursive flow: main → booking → tee times → login/links")
        courses = self._load_courses()
        if not courses:
            print("[DEBUG] No courses loaded. Exiting.")
            return
        course = courses[0]  # Just use the first course
        main_url = course['url']
        username = os.getenv("GOLF_USERNAME")
        password = os.getenv("GOLF_PASSWORD")
        crawler = AsyncWebCrawler(config=BrowserConfig(headless=False))
        await crawler.start()
        try:
            print(f"[STEP 1] Navigating to main site: {main_url}")
            # Step 2: Find booking URL
            booking_url = await self._find_booking_url_via_arun(crawler, main_url)
            if not booking_url:
                print("[ERROR] Could not find booking URL on main page.")
                return
            print(f"[STEP 3] Found booking URL: {booking_url}")
            # Step 3/4/5: Recursively try to find tee times, login, or click more links
            found = await self._recursive_tee_time_search_arun(crawler, booking_url, username, password, depth=0, max_depth=5)
            if found:
                print("[SUCCESS] Tee times found!")
            else:
                print("[FAILURE] Could not find tee times after 5 link hops.")
        finally:
            await crawler.close()
            print("[DEBUG] Browser closed")

    async def _find_booking_url_via_arun(self, crawler, url):
        """Use arun to load the page and find the booking URL."""
        found_url = None
        async def after_goto(page, context, url, response, **kwargs):
            nonlocal found_url
            found_url = await self._find_booking_url_on_page(page)
            return page
        crawler.crawler_strategy.set_hook("after_goto", after_goto)
        await crawler.arun(url, config=CrawlerRunConfig(cache_mode=CacheMode.BYPASS, wait_for="body"))
        return found_url

    async def _recursive_tee_time_search_arun(self, crawler, url, username, password, depth=0, max_depth=5):
        if depth > max_depth:
            print(f"[DEBUG] Max depth {max_depth} reached.")
            return False
        print(f"[RECURSE] Depth {depth}: Navigating to {url}")
        result = {'tee_times_found': False, 'login_needed': False, 'next_url': None}
        async def after_goto(page, context, url, response, **kwargs):
            # Step 3: Check for tee times
            if await self._detect_tee_times(page):
                print(f"[RECURSE] Tee times found at {url}")
                result['tee_times_found'] = True
                return page
            # Step 4: Check for login
            if await self._check_for_login_fields(page):
                print(f"[RECURSE] Login required at {url}, attempting login...")
                result['login_needed'] = True
                if username and password:
                    await self._perform_login(page, username, password, self._get_login_selectors(), self._get_password_selectors())
                    await asyncio.sleep(2)
                    if await self._detect_tee_times(page):
                        print(f"[RECURSE] Tee times found after login at {url}")
                        result['tee_times_found'] = True
                else:
                    print("[RECURSE] No credentials, cannot login.")
            # Step 5: Try another link recursively
            if not result['tee_times_found']:
                print(f"[RECURSE] Looking for another candidate link at {url}")
                next_url = await self._find_next_candidate_link(page)
                if next_url and next_url != url:
                    result['next_url'] = next_url
            return page
        crawler.crawler_strategy.set_hook("after_goto", after_goto)
        await crawler.arun(url, config=CrawlerRunConfig(cache_mode=CacheMode.BYPASS, wait_for="body"))
        if result['tee_times_found']:
            return True
        if result['next_url']:
            return await self._recursive_tee_time_search_arun(crawler, result['next_url'], username, password, depth+1, max_depth)
        print(f"[RECURSE] No more candidate links at {url}")
        return False

    async def _find_booking_url_on_page(self, page):
        """Scan the page for a booking URL (known patterns)."""
        # Priority booking systems (these should be found first)
        priority_patterns = [
            'foreup.com', 'teeitup.golf', 'golfnow.com', 'chronogolf.com', 'teeoff.com',
            'golf18network.com', 'ezlinks.com', 'teesnap.com', 'golfzing.com'
        ]
        
        # General booking patterns
        booking_patterns = [
            'book', 'reserve', 'tee time', 'teetime', 'booking', 'calendar', 'schedule'
        ]
        
        # Sites to exclude (social media, etc.)
        exclude_patterns = [
            'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'linkedin.com',
            'pinterest.com', 'tiktok.com', 'snapchat.com', 'reddit.com', 'yelp.com',
            'google.com', 'maps.google.com', 'wikipedia.org', 'amazon.com', 'ebay.com'
        ]
        
        anchors = await page.query_selector_all('a')
        
        # First, look for priority booking systems
        for a in anchors:
            try:
                href = await a.get_attribute('href')
                if href:
                    href_lower = href.lower()
                    # Check if it's a priority booking system
                    if any(p in href_lower for p in priority_patterns):
                        print(f"[DEBUG] Found priority booking link: {href}")
                        return href if href.startswith('http') else page.url.rstrip('/') + '/' + href.lstrip('/')
            except Exception as e:
                continue
        
        # Then look for general booking patterns, but exclude social media
        for a in anchors:
            try:
                href = await a.get_attribute('href')
                if href:
                    href_lower = href.lower()
                    # Skip if it's a social media or excluded site
                    if any(exclude in href_lower for exclude in exclude_patterns):
                        continue
                    # Check if it matches booking patterns
                    if any(p in href_lower for p in booking_patterns):
                        print(f"[DEBUG] Found general booking link: {href}")
                        return href if href.startswith('http') else page.url.rstrip('/') + '/' + href.lstrip('/')
            except Exception as e:
                continue
        
        print("[DEBUG] No booking URL found on page")
        return None

    async def _detect_tee_times(self, page):
        """Detect if tee times are present on the page."""
        # Look for specific golf booking indicators
        golf_booking_patterns = [
            'select a tee time', 'choose a tee time', 'available tee times', 'book your tee time',
            'tee time booking', 'golf tee times', 'reserve tee time', 'book tee time',
            'foreup', 'teeitup', 'golfnow', 'tee time calendar', 'golf booking calendar',
            'time slot', 'booking slot', 'golf reservation', 'tee time reservation'
        ]
        
        # Look for specific booking widgets or forms
        booking_widget_patterns = [
            'booking widget', 'tee time widget', 'golf booking', 'reservation system',
            'select date', 'select time', 'choose date', 'choose time', 'date picker',
            'time picker', 'calendar widget', 'booking calendar'
        ]
        
        # Look for actual booking buttons or forms
        booking_action_patterns = [
            'book now', 'reserve now', 'book tee time', 'reserve tee time', 'select time',
            'choose time', 'book golf', 'reserve golf', 'book online', 'reserve online'
        ]
        
        content = (await page.content()).lower()
        
        # Check for golf-specific booking patterns first
        for p in golf_booking_patterns:
            if p in content:
                print(f"[DEBUG] Detected golf booking pattern: {p}")
                return True
        
        # Check for booking widgets
        for p in booking_widget_patterns:
            if p in content:
                print(f"[DEBUG] Detected booking widget pattern: {p}")
                return True
        
        # Check for booking actions
        for p in booking_action_patterns:
            if p in content:
                print(f"[DEBUG] Detected booking action pattern: {p}")
                return True
        
        # Also check for specific booking system URLs in the page
        booking_systems = ['foreup.com', 'teeitup.golf', 'golfnow.com', 'chronogolf.com']
        for system in booking_systems:
            if system in content:
                print(f"[DEBUG] Detected booking system: {system}")
                return True
        
        print("[DEBUG] No tee time booking indicators found")
        return False

    async def _find_next_candidate_link(self, page):
        """Find another candidate link to try for tee times."""
        candidate_patterns = [
            'tee', 'book', 'reserve', 'calendar', 'times', 'golfnow', 'foreup', 'booking', 'availability', 'schedule'
        ]
        anchors = await page.query_selector_all('a')
        for a in anchors:
            try:
                href = await a.get_attribute('href')
                text = (await a.text_content() or '').lower()
                if href and any(p in href.lower() for p in candidate_patterns):
                    print(f"[DEBUG] Found candidate link by href: {href}")
                    return href if href.startswith('http') else page.url.rstrip('/') + '/' + href.lstrip('/')
                if any(p in text for p in candidate_patterns):
                    print(f"[DEBUG] Found candidate link by text: {text}")
                    href = href or ''
                    return href if href.startswith('http') else page.url.rstrip('/') + '/' + href.lstrip('/')
            except Exception as e:
                continue
        return None

def main():
    """Main entry point for the crawler."""
    crawler = GolfCourseCrawler()
    asyncio.run(crawler.find_booking_url_and_login())

if __name__ == "__main__":
    main() 
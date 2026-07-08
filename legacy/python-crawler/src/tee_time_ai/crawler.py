"""
Crawler module for TeeTimeAI.
Handles web crawling to find booking URLs for golf courses and extract tee time data.
"""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
from playwright.async_api import Page, BrowserContext

# Load environment variables from .env file
load_dotenv()

class GolfCourseCrawler:
    """Handles crawling to find booking URLs for golf courses and extract tee time data."""
    
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
            found, tee_time_data = await self._recursive_tee_time_search_arun(crawler, booking_url, username, password, depth=0, max_depth=5)
            if found:
                print("[SUCCESS] Tee times found!")
                # Update the course data with tee time information
                self._update_course_with_tee_times(course, tee_time_data)
                # Save the updated courses
                self._save_courses(courses)
                print(f"[SUCCESS] Updated golf_courses.json with tee time data for {course.get('name', 'course')}")
            else:
                print("[FAILURE] Could not find tee times after 5 link hops.")
        finally:
            await crawler.close()
            print("[DEBUG] Browser closed")

    def _update_course_with_tee_times(self, course, tee_time_data):
        """Update course data with tee time information from API responses."""
        if not tee_time_data:
            print("[DEBUG] No tee time data to update")
            return
        
        # Extract tee time information from API data
        tee_times = []
        for api_response in tee_time_data:
            if isinstance(api_response['data'], list):
                for slot in api_response['data']:
                    if isinstance(slot, dict) and 'time' in slot:
                        tee_time_info = {
                            'time': slot.get('time'),
                            'available_spots': slot.get('available_spots', 0),
                            'green_fee': slot.get('green_fee', 0),
                            'holes': slot.get('holes', 18),
                            'course_name': slot.get('course_name'),
                            'rate_type': slot.get('rate_type', 'walking'),
                            'cart_fee': slot.get('cart_fee', 0),
                            'booking_class_id': slot.get('booking_class_id'),
                            'schedule_id': slot.get('schedule_id')
                        }
                        tee_times.append(tee_time_info)
        
        # Update course data
        course['tee_times'] = tee_times
        course['last_updated'] = datetime.now().isoformat()
        course['booking_url'] = tee_time_data[0].get('url', course.get('booking_url', ''))
        
        # Add summary information
        if tee_times:
            course['tee_time_summary'] = {
                'total_slots': len(tee_times),
                'total_available_spots': sum(slot.get('available_spots', 0) for slot in tee_times),
                'price_range': {
                    'min_green_fee': min(slot.get('green_fee', 0) for slot in tee_times),
                    'max_green_fee': max(slot.get('green_fee', 0) for slot in tee_times)
                },
                'date_range': {
                    'earliest_time': min(slot.get('time', '') for slot in tee_times),
                    'latest_time': max(slot.get('time', '') for slot in tee_times)
                }
            }
        
        print(f"[DEBUG] Updated course with {len(tee_times)} tee time slots")

    async def _recursive_tee_time_search_arun(self, crawler, url, username, password, depth=0, max_depth=5):
        if depth > max_depth:
            print(f"[DEBUG] Max depth {max_depth} reached.")
            return False, []
        print(f"[RECURSE] Depth {depth}: Navigating to {url}")
        result = {'tee_times_found': False, 'login_needed': False, 'next_url': None, 'api_data': []}
        
        async def after_goto(page, context, url, response, **kwargs):
            # Set up API call interception
            api_responses = []
            
            async def handle_route(route):
                if 'api' in route.request.url and ('booking' in route.request.url or 'times' in route.request.url):
                    print(f"[API] Intercepted API call: {route.request.url}")
                    try:
                        response = await route.fetch()
                        if response.status == 200:
                            content_type = response.headers.get('content-type', '')
                            if 'json' in content_type or 'application/json' in content_type:
                                json_data = await response.json()
                                api_responses.append({
                                    'url': route.request.url,
                                    'data': json_data
                                })
                                print(f"[API] Captured JSON response with {len(json_data) if isinstance(json_data, list) else 1} items")
                    except Exception as e:
                        print(f"[API] Error capturing response: {e}")
                await route.continue_()
            
            # Start intercepting API calls
            await page.route("**/*", handle_route)
            
            # Step 3: Check for tee times using API data first, then fallback to page content
            if api_responses:
                result['api_data'] = api_responses
                # Check if API responses contain tee time data
                for api_response in api_responses:
                    if self._check_api_for_tee_times(api_response['data']):
                        print(f"[RECURSE] Tee times found via API at {url}")
                        result['tee_times_found'] = True
                        return page
            
            # Fallback to page content detection
            if await self._detect_tee_times(page):
                print(f"[RECURSE] Tee times found via page content at {url}")
                result['tee_times_found'] = True
                return page
            
            # Step 4: Check for login
            if await self._check_for_login_fields(page):
                print(f"[RECURSE] Login required at {url}, attempting login...")
                result['login_needed'] = True
                if username and password:
                    await self._perform_login(page, username, password, self._get_login_selectors(), self._get_password_selectors())
                    await asyncio.sleep(2)
                    
                    # After login, check for API calls again
                    await asyncio.sleep(3)  # Wait for any post-login API calls
                    if api_responses:
                        result['api_data'] = api_responses
                        for api_response in api_responses:
                            if self._check_api_for_tee_times(api_response['data']):
                                print(f"[RECURSE] Tee times found via API after login at {url}")
                                result['tee_times_found'] = True
                                return page
                    
                    # Fallback to page content after login
                    if await self._detect_tee_times(page):
                        print(f"[RECURSE] Tee times found via page content after login at {url}")
                        result['tee_times_found'] = True
                        return page
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
        
        # Print captured API data if found
        if result['api_data']:
            print(f"[API] Captured {len(result['api_data'])} API responses")
            for i, api_response in enumerate(result['api_data']):
                print(f"[API] Response {i+1}: {api_response['url']}")
                if isinstance(api_response['data'], list):
                    print(f"[API] Contains {len(api_response['data'])} tee time slots")
                elif isinstance(api_response['data'], dict):
                    print(f"[API] Contains tee time data: {list(api_response['data'].keys())}")
        
        if result['tee_times_found']:
            return True, result['api_data']
        if result['next_url']:
            return await self._recursive_tee_time_search_arun(crawler, result['next_url'], username, password, depth+1, max_depth)
        print(f"[RECURSE] No more candidate links at {url}")
        return False, []

    def _check_api_for_tee_times(self, api_data):
        """Check if API response contains actual tee time data."""
        try:
            if isinstance(api_data, list):
                # Check if it's a list of tee time objects
                if len(api_data) > 0:
                    first_item = api_data[0]
                    # Look for tee time indicators in the first item
                    tee_time_indicators = ['time', 'available_spots', 'green_fee', 'course_name', 'holes']
                    if any(indicator in first_item for indicator in tee_time_indicators):
                        print(f"[API] Found {len(api_data)} tee time slots in API response")
                        return True
            
            elif isinstance(api_data, dict):
                # Check if it's a single tee time object or contains tee time data
                tee_time_indicators = ['time', 'available_spots', 'green_fee', 'course_name', 'holes']
                if any(indicator in api_data for indicator in tee_time_indicators):
                    print(f"[API] Found tee time data in API response")
                    return True
                
                # Check if it contains a list of tee times
                for key, value in api_data.items():
                    if isinstance(value, list) and len(value) > 0:
                        if self._check_api_for_tee_times(value):
                            return True
            
            return False
        except Exception as e:
            print(f"[API] Error checking API data: {e}")
            return False

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
        """Detect if actual tee times are present on the page (multiple time slots on a date)."""
        try:
            # Look for time slot patterns (actual available times)
            time_slot_patterns = [
                r'\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)',  # Time formats like 9:00 AM, 2:30 PM
                r'\d{1,2}:\d{2}',  # Time formats like 9:00, 14:30
                r'\d{1,2}:\d{2}\s*[AaPp][Mm]',  # Time with AM/PM
            ]
            
            # Look for availability indicators
            availability_patterns = [
                'available', 'book now', 'reserve now', 'select this time', 'choose this time',
                'open', 'green', 'available slot', 'time slot', 'tee time slot'
            ]
            
            # Look for multiple time slots in a grid or list
            multiple_slots_patterns = [
                'time slots', 'available times', 'tee times', 'booking slots', 'time options',
                'select time', 'choose time', 'pick time'
            ]
            
            content = await page.content()
            content_lower = content.lower()
            
            # Check if we're on a login page (if so, we haven't found tee times yet)
            login_indicators = ['login', 'sign in', 'username', 'password', 'email', 'member login']
            if any(indicator in content_lower for indicator in login_indicators):
                print("[DEBUG] Page appears to be a login page - no tee times found yet")
                return False
            
            # Look for actual time slots using regex
            import re
            time_slots_found = []
            for pattern in time_slot_patterns:
                matches = re.findall(pattern, content)
                time_slots_found.extend(matches)
            
            # Remove duplicates and filter out obvious non-tee times
            unique_times = list(set(time_slots_found))
            # Filter out times that are likely not tee times (like page load times, etc.)
            filtered_times = [time for time in unique_times if len(time) >= 4]  # At least 4 chars like "9:00"
            
            print(f"[DEBUG] Found {len(filtered_times)} potential time slots: {filtered_times[:10]}...")  # Show first 10
            
            # Need at least 3 time slots to consider it a tee time page
            if len(filtered_times) >= 3:
                print(f"[DEBUG] Found {len(filtered_times)} time slots - likely tee times available")
                return True
            
            # Also check for availability indicators combined with time-related content
            has_availability = any(pattern in content_lower for pattern in availability_patterns)
            has_multiple_slots = any(pattern in content_lower for pattern in multiple_slots_patterns)
            
            if has_availability and has_multiple_slots and len(filtered_times) >= 1:
                print(f"[DEBUG] Found availability indicators with {len(filtered_times)} time slots")
                return True
            
            # Check for specific booking system content that indicates tee time availability
            booking_systems = ['foreup.com', 'teeitup.golf', 'golfnow.com', 'chronogolf.com']
            for system in booking_systems:
                if system in content_lower:
                    # Only consider it a tee time page if we also have time slots or availability
                    if len(filtered_times) >= 1 or has_availability:
                        print(f"[DEBUG] Found booking system {system} with time/availability indicators")
                        return True
            
            print(f"[DEBUG] No sufficient tee time indicators found. Time slots: {len(filtered_times)}, Availability: {has_availability}")
            return False
            
        except Exception as e:
            print(f"[DEBUG] Error in tee time detection: {e}")
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

def main():
    """Main entry point for the crawler."""
    crawler = GolfCourseCrawler()
    asyncio.run(crawler.find_booking_url_and_login())

if __name__ == "__main__":
    main() 
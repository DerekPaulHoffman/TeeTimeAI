# Golf Tee Times AI

Golf Tee Times AI is a personal MVP project that finds available tee times at golf courses based on your scheduling preferences and location. It uses AI-powered scraping and automation to pull tee time availability from course websites.

## 🏌️ Project Overview (WIP)

This app lets you:
- Enter a date, time range, and location (zip code + radius)
- Automatically discover nearby golf courses
- Scrape their websites for available tee times
- Return structured results showing options that match your preferences


## Setup & Running

1. Create and activate a virtual environment:
   ```bash
   # Windows Command Prompt
   python -m venv .venv
   .venv\Scripts\activate

   # Git Bash
   python -m venv .venv
   source .venv/Scripts/activate
   ```

2. Install the package in development mode:
   ```bash
   cd backend
   pip install -e .
   ```

3. Run the crawler to update golf course booking URLs:
   ```bash
   # From /c/dev/TeeTimeAI/backend
   python -m tee_time_ai.crawler
   ```

The crawler will:
- Read golf course data from `golf_courses.json`
- Visit each course's website
- Find and update their booking URLs
- Save the updated information back to the JSON file

## Development

- The backend is organized as a Python package for better maintainability
- Golf course data is stored in `golf_courses.json`
- Future frontend will be built with Vite

## License

MIT 
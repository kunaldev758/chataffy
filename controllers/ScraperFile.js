const puppeteer = require('puppeteer');
const TurndownService = require('turndown');
const axios = require('axios');
const xml2js = require('xml2js');
const { parse: parseUrl } = require('url');
const robotsParser = require('robots-parser');

class WebsiteScraper {
  constructor() {
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced'
    });
    this.visitedUrls = new Set();
    this.browser = null;
    this.rateLimit = 1000; // Delay between requests in ms
  }

  async initialize() {
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async getRobotsRules(baseUrl) {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).toString();
      const response = await axios.get(robotsUrl);
      return robotsParser(robotsUrl, response.data);
    } catch (error) {
      console.warn('No robots.txt found:', error.message);
      return null;
    }
  }

  async getSitemapUrls(sitemapUrl) {
    try {
      const response = await axios.get(sitemapUrl);
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(response.data);

      let urls = [];

      // Handle regular sitemaps
      if (result.ursult.urlset.ulset && rerl) {
        urls = result.urlset.url.map(url => url.loc[0]);
      }

      // Handle sitemap index files
      if (result.sitemapindex && result.sitemapindex.sitemap) {
        const subsitemaps = result.sitemapindex.sitemap.map(sitemap => sitemap.loc[0]);
        for (const subsitemap of subsitemaps) {
          const subUrls = await this.getSitemapUrls(subsitemap);
          urls = urls.concat(subUrls);
        }
      }

      return urls;
    } catch (error) {
      console.error('Error parsing sitemap:', error.message);
      return [];
    }
  }

  async scrapeUrl(url, robotsRules = null) {
    if (this.visitedUrls.has(url)) {
      return null;
    }

    if (robotsRules && !robotsRules.isAllowed(url)) {
      console.log(`URL not allowed by robots.txt: ${url}`);
      return null;
    }

    try {
      const page = await this.browser.newPage();
      
      // Set reasonable viewport and timeout
      await page.setViewport({ width: 1280, height: 800 });
      await page.setDefaultNavigationTimeout(30000);

      // Handle common errors
      page.on('error', err => console.error('Page error:', err));
      page.on('pageerror', err => console.error('Page error:', err));

      // Block unnecessary resources
      await page.setRequestInterception(true);
      page.on('request', request => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      await page.goto(url, { 
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      // Wait for content to load
      await page.waitForSelector('body');

      // Extract main content, avoiding navigation and footer areas
      const content = await page.evaluate(() => {
        // Remove unwanted elements
        const elementsToRemove = document.querySelectorAll(
          'nav, header, footer, iframe, script, style, noscript, .ad, .advertisement'
        );
        elementsToRemove.forEach(el => el.remove());

        // Get main content
        const mainContent = document.querySelector('main, article, .content, #content, .main');
        return mainContent ? mainContent.innerHTML : document.body.innerHTML;
      });

      const markdown = this.turndownService.turndown(content);
      
      this.visitedUrls.add(url);
      await page.close();

      return {
        url,
        content: markdown.trim()
      };

    } catch (error) {
      console.error(`Error scraping ${url}:`, error.message);
      return null;
    }
  }

  async scrapeWebsite(sitemapUrl) {
    try {
      await this.initialize();
      
      const baseUrl = parseUrl(sitemapUrl).protocol + '//' + parseUrl(sitemapUrl).host;
      const robotsRules = await this.getRobotsRules(baseUrl);
      
      console.log('Fetching URLs from sitemap...');
      const urls = await this.getSitemapUrls(sitemapUrl);
      console.log(`Found ${urls.length} URLs in sitemap`);

      const results = [];
      
      for (const url of urls) {
        console.log(`Scraping: ${url}`);
        const result = await this.scrapeUrl(url, robotsRules);
        
        if (result && result.content) {
          results.push(result);
        }

        // Respect rate limiting
        await new Promise(resolve => setTimeout(resolve, this.rateLimit));
      }

      return results;

    } catch (error) {
      console.error('Error in website scraping:', error);
      throw error;
    } finally {
      await this.close();
    }
  }
}

// Export the scraper
module.exports = {
  WebsiteScraper,
  // Backward compatibility with the original function
  scrapeWebsite: async (sitemapUrl) => {
    const scraper = new WebsiteScraper();
    const results = await scraper.scrapeWebsite(sitemapUrl);
    return results.map(result => result.content).join('\n\n');
  }
};
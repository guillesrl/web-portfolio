/**
 * GitHub Portfolio - Main Script
 * Fetches and displays GitHub repositories
 */

// ===== Configuration =====
const CONFIG = (() => {
    // Try to load from config.js first
    if (typeof GITHUB_TOKEN !== 'undefined' && typeof GITHUB_USERNAME !== 'undefined') {
        return {
            token: GITHUB_TOKEN,
            username: GITHUB_USERNAME
        };
    }

    // Fallback to default values
    return {
        token: '',
        username: 'guillesrl'
    };
})();

const API_BASE = 'https://api.github.com';
const PER_PAGE = 100;
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutos
const EXCLUDED_REPOSITORIES = new Set([
    'web-inventario',
    'web-portfolio',
    'peluqueria-premium',
    'ai-landing',
    'omarchy'
]);
const PREVIEW_IMAGES = {
    'web-nails': 'https://raw.githubusercontent.com/guillesrl/web-nails/main/public/media/hero-nails.jpg',
    'web-peluqueria': 'https://raw.githubusercontent.com/guillesrl/web-peluqueria/main/media/salon-hero-poster.jpg'
};

// ===== State =====
let allRepos = [];
let sortBy = 'updated';
let lastFetchTime = null;

// ===== DOM Elements =====
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorMessageEl = document.getElementById('errorMessage');
const projectsGridEl = document.getElementById('projectsGrid');
const searchInputEl = document.getElementById('searchInput');
const sortSelectEl = document.getElementById('sortSelect');
const lastUpdatedEl = document.getElementById('lastUpdated');

// ===== Event Listeners =====
searchInputEl.addEventListener('input', filterAndRenderProjects);
sortSelectEl.addEventListener('change', (e) => {
    sortBy = e.target.value;
    filterAndRenderProjects();
});

// ===== Cache Functions =====
function getCachedRepos() {
    try {
        const cached = localStorage.getItem('portfolio_repos');
        const timestamp = localStorage.getItem('portfolio_timestamp');

        if (cached && timestamp) {
            const cacheAge = Date.now() - parseInt(timestamp);
            if (cacheAge < CACHE_DURATION_MS) {
                return JSON.parse(cached);
            }
        }
    } catch (e) {
        console.warn('Failed to read from cache:', e);
    }
    return null;
}

function setCachedRepos(repos) {
    try {
        localStorage.setItem('portfolio_repos', JSON.stringify(repos));
        localStorage.setItem('portfolio_timestamp', Date.now().toString());
    } catch (e) {
        console.warn('Failed to write to cache:', e);
    }
}

function updateLastUpdatedDisplay() {
    if (!lastUpdatedEl) return;

    const timestamp = localStorage.getItem('portfolio_timestamp');
    if (timestamp) {
        const date = new Date(parseInt(timestamp));
        const now = Date.now();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);

        let text;
        if (diffMins < 1) {
            text = 'Updated just now';
        } else if (diffMins < 60) {
            text = `Updated ${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
        } else if (diffMins < 1440) { // menos de 24 horas
            const hours = Math.floor(diffMins / 60);
            text = `Updated ${hours} hour${hours !== 1 ? 's' : ''} ago`;
        } else {
            text = `Updated ${date.toLocaleDateString()}`;
        }

        lastUpdatedEl.textContent = text;
        lastUpdatedEl.title = `Last updated: ${date.toLocaleString()}`;
    }
}

// ===== API Functions =====
async function fetchWithAuth(url) {
    const headers = {
        'Accept': 'application/vnd.github.v3+json'
    };

    if (CONFIG.token) {
        headers['Authorization'] = `token ${CONFIG.token}`;
    }

    const response = await fetch(url, { headers });

    // Check for rate limiting
    if (response.status === 403) {
        const resetTime = response.headers.get('X-RateLimit-Reset');
        const remaining = response.headers.get('X-RateLimit-Remaining');
        console.warn(`Rate limit exceeded. Remaining: ${remaining}. Reset at: ${resetTime}`);
    }

    if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response;
}

async function fetchRepos() {
    const url = `${API_BASE}/users/${CONFIG.username}/repos?per_page=${PER_PAGE}&sort=updated&direction=desc`;
    return fetchWithAuth(url).then(res => res.json());
}

async function fetchReadme(owner, repo) {
    const url = `${API_BASE}/repos/${owner}/${repo}/readme`;
    try {
        const response = await fetchWithAuth(url);
        return await response.json();
    } catch (error) {
        // README might not exist - handle 404 silently
        if (error.message === 'Not Found' || error.message.includes('404')) {
            return null;
        }
        // For other errors, log a warning but don't fail
        console.warn(`Failed to fetch README for ${repo}:`, error.message);
        return null;
    }
}

async function fetchRepoContents(owner, repo, path = '') {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;
    try {
        const response = await fetchWithAuth(url);
        if (!response.ok) {
            return null; // Any error (404, empty repo, etc.) just return null
        }
        return await response.json();
    } catch (error) {
        // Silently ignore all errors - image not found is normal
        return null;
    }
}

// ===== Data Processing =====
function extractImageFromReadme(readmeContent) {
    if (!readmeContent || !readmeContent.content) {
        return null;
    }

    try {
        // Decode base64 content - it's markdown, not HTML
        const markdown = atob(readmeContent.content);

        // Look for markdown image syntax: ![alt](url)
        const mdImageRegex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
        let match;
        while ((match = mdImageRegex.exec(markdown)) !== null) {
            const url = match[1];
            // Skip small icons and social images
            if (url.includes('avatar') || url.includes('icon') || url.includes('badge') || url.includes('shield')) {
                continue;
            }
            // Return first valid image URL
            if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                return url;
            }
        }
    } catch (error) {
        console.warn('Failed to parse README:', error);
    }

    return null;
}

async function findImageInRepository(owner, repo, defaultBranch) {
    // Only check root directory - most screenshots are stored there
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    const rootContents = await fetchRepoContents(owner, repo, '');
    if (!rootContents || !Array.isArray(rootContents)) return null;

    for (const item of rootContents) {
        if (item.type === 'file') {
            const lowerName = item.name.toLowerCase();
            if (imageExtensions.some(ext => lowerName.endsWith(ext))) {
                return `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${item.path}`;
            }
        }
    }
    return null;
}

async function extractImageForRepo(repo, readme) {
    const projectPreview = PREVIEW_IMAGES[repo.name.toLowerCase()];
    if (projectPreview) {
        return projectPreview;
    }

    // First try: extract from README
    const readmeImage = extractImageFromReadme(readme);
    if (readmeImage) {
        return readmeImage;
    }

    // Second try: find an image file in repository
    const defaultBranch = repo.default_branch || 'main';
    const repoImage = await findImageInRepository(repo.owner.login, repo.name, defaultBranch);
    if (repoImage) {
        return repoImage;
    }

    return null;
}

function processRepo(repo, readme, imageUrl = null) {
    return {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || 'No description provided.',
        url: repo.html_url,
        homepage: repo.homepage,
        language: repo.language,
        topics: repo.topics || [],
        stars: repo.stargazers_count,
        createdAt: repo.created_at,
        updatedAt: repo.updated_at,
        imageUrl: imageUrl,
        hasReadme: !!readme
    };
}

async function fetchAllReposWithReadme(repos) {
    // Fetch readmes and images for ALL repositories
    // Note: This makes more API calls but ensures all repos get images
    const repoDataPromises = repos.map(async (repo) => {
        const readme = await fetchReadme(repo.owner.login, repo.name);
        const imageUrl = await extractImageForRepo(repo, readme);
        return { repo, readme, imageUrl };
    });

    const results = await Promise.all(repoDataPromises);

    return results.map(({ repo, readme, imageUrl }) => processRepo(repo, readme, imageUrl));
}

function sortRepos(repos, sortBy) {
    const sorted = [...repos];

    switch (sortBy) {
        case 'stars':
            sorted.sort((a, b) => b.stars - a.stars);
            break;
        case 'name':
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case 'updated':
        default:
            sorted.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            break;
    }

    return sorted;
}

function filterRepos(repos, searchTerm) {
    if (!searchTerm) return repos;

    const term = searchTerm.toLowerCase();
    return repos.filter(repo =>
        repo.name.toLowerCase().includes(term) ||
        repo.description.toLowerCase().includes(term) ||
        (repo.language && repo.language.toLowerCase().includes(term)) ||
        repo.topics.some(topic => topic.toLowerCase().includes(term))
    );
}

function excludeRepositories(repos) {
    return repos.filter(repo => !EXCLUDED_REPOSITORIES.has(repo.name.toLowerCase()));
}

function applyPreviewOverrides(repos) {
    return repos.map(repo => ({
        ...repo,
        imageUrl: PREVIEW_IMAGES[repo.name.toLowerCase()] || repo.imageUrl
    }));
}

// ===== Rendering =====
function generatePlaceholderImage(projectName) {
    // Return empty string - no placeholder image section
    return '';
}

function createProjectCard(project) {
    const date = new Date(project.updatedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });

    const languageBadge = project.language
        ? `<span class="project-card__tag">${escapeHtml(project.language)}</span>`
        : '';

    const topicBadges = project.topics.slice(0, 3).map(topic =>
        `<span class="project-card__tag">${escapeHtml(topic)}</span>`
    ).join('');

    const imageHtml = project.imageUrl
        ? `<div class="project-card__image"><img src="${escapeHtml(project.imageUrl)}" alt="${escapeHtml(project.name)}" loading="lazy"></div>`
        : generatePlaceholderImage(project.name);

    const demoLink = project.homepage
        ? `<a href="${escapeHtml(project.homepage)}" target="_blank" rel="noopener noreferrer" class="project-card__link project-card__link--primary">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M14 3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414l1.203 1.203a.996.996 0 0 1-1.414 0L2.586 11H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h12z"/>
                <path d="M11 2.5A1.5 1.5 0 0 1 12.5 1 1.5 1.5 0 0 1 14 2.5V4h1v-.5zM9.5 2a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1z"/>
            </svg>
            Live Demo
        </a>`
        : '';

    return `
        <article class="project-card">
            ${imageHtml}
            <div class="project-card__content">
                <div class="project-card__header">
                    <h3 class="project-card__name">
                        <a href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer">
                            ${escapeHtml(project.name)}
                        </a>
                    </h3>
                </div>
                <p class="project-card__description">${escapeHtml(project.description)}</p>
                <div class="project-card__meta">
                    ${languageBadge}
                    ${topicBadges}
                </div>
                <div class="project-card__stats">
                    <span class="project-card__stat">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/>
                        </svg>
                        ${project.stars}
                    </span>
                    <span class="project-card__stat">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M11.91 6.328a.5.5 0 0 0-.848-.478l-3.75 2.5-.75-1.5-3.25 2.125a.5.5 0 0 0-.356.263l-1 2.75a.5.5 0 0 0 .629.598l2.75-1 .75 2.75 2.75-.75a.5.5 0 0 0 .598-.629l1-2.75a.5.5 0 0 0-.263-.356l-3.25-2.125-.75 1.5 3.75-2.5a.5.5 0 0 0 .848.478l-2.25 1.5A.5.5 0 0 0 8 6.91l2.25-1.5z"/>
                        </svg>
                        ${date}
                    </span>
                </div>
                <div class="project-card__actions">
                    <a href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer" class="project-card__link project-card__link--secondary">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                        </svg>
                        View Code
                    </a>
                    ${demoLink}
                </div>
            </div>
        </article>
    `;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function filterAndRenderProjects() {
    const searchTerm = searchInputEl.value.trim();
    const filteredRepos = filterRepos(allRepos, searchTerm);
    const sortedRepos = sortRepos(filteredRepos, sortBy);
    renderProjects(sortedRepos);
}

function renderProjects(repos) {
    if (repos.length === 0) {
        projectsGridEl.innerHTML = `
            <div class="error">
                <p>${allRepos.length === 0 ? 'No repositories found.' : 'No repositories match your search.'}</p>
            </div>
        `;
        return;
    }

    projectsGridEl.innerHTML = repos.map(createProjectCard).join('');
}

// ===== Initialization =====
async function init() {
    try {
        loadingEl.style.display = 'block';
        errorEl.style.display = 'none';
        projectsGridEl.innerHTML = '';

        // Try to load from cache first
        const cachedRepos = getCachedRepos();

        if (cachedRepos && cachedRepos.length > 0) {
            console.log('Loading from cache');
            allRepos = applyPreviewOverrides(excludeRepositories(cachedRepos));
            setCachedRepos(allRepos);
            filterAndRenderProjects();
            updateLastUpdatedDisplay();
            loadingEl.style.display = 'none';

            // Try to refresh in background if cache is getting old
            const timestamp = localStorage.getItem('portfolio_timestamp');
            const cacheAge = Date.now() - parseInt(timestamp || '0');
            if (cacheAge > CACHE_DURATION_MS * 0.7) { // Refresh if older than 70% of TTL
                refreshDataInBackground();
            }
            return;
        }

        // No valid cache, fetch from API
        const repos = await fetchRepos();

        if (repos.length === 0) {
            throw new Error('No repositories found for this user.');
        }

        // Exclude repositories that should not appear in this portfolio.
        const filteredRepos = excludeRepositories(repos);
        console.log(`Filtered out ${repos.length - filteredRepos.length} repository(ies)`);

        if (filteredRepos.length === 0) {
            throw new Error('No repositories to display after filtering.');
        }

        // Fetch readmes for preview images
        allRepos = await fetchAllReposWithReadme(filteredRepos);

        // Cache the results
        setCachedRepos(allRepos);

        filterAndRenderProjects();
        updateLastUpdatedDisplay();
    } catch (error) {
        console.error('Failed to load repositories:', error);

        // Try to use stale cache as fallback
        const cachedRepos = getCachedRepos();
        if (cachedRepos && cachedRepos.length > 0) {
            console.warn('Using stale cache due to API error');
            allRepos = cachedRepos;
            filterAndRenderProjects();
            updateLastUpdatedDisplay();
            if (lastUpdatedEl) {
                lastUpdatedEl.textContent += ' (stale)';
            }
        } else {
            errorMessageEl.textContent = `Failed to load repositories: ${error.message}`;
            errorEl.style.display = 'block';
        }
    } finally {
        loadingEl.style.display = 'none';
    }
}

// Refresh data in background without blocking UI
async function refreshDataInBackground() {
    try {
        console.log('Refreshing data in background...');
        const repos = await fetchRepos();
        if (repos.length > 0) {
            // Exclude repositories that should not appear in this portfolio.
            const filteredRepos = excludeRepositories(repos);
            if (filteredRepos.length > 0) {
                const freshRepos = await fetchAllReposWithReadme(filteredRepos);
                allRepos = freshRepos;
                setCachedRepos(allRepos);
                filterAndRenderProjects();
                updateLastUpdatedDisplay();
                console.log('Background refresh complete');
            }
        }
    } catch (error) {
        console.warn('Background refresh failed:', error.message);
        // Don't show error to user, keep showing cached data
    }
}

// Start application
document.addEventListener('DOMContentLoaded', init);

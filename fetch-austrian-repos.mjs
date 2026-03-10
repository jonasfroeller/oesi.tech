/**
 * Fetch all Austrian GitHub repositories with more than 50 stars
 * using Octokit and the GitHub GraphQL API.
 *
 * Strategy:
 * 1. Find users/orgs located in Austria (multiple city/country queries)
 * 2. For each user, also discover the organizations they belong to
 * 3. Fetch repos with ≥50 stars from all discovered users + orgs
 *
 * Usage:
 *   GITHUB_TOKEN=<your_token> bun fetch-austrian-repos.mjs
 */

import { graphql } from "@octokit/graphql";
import { writeFileSync } from "fs";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("Missing GITHUB_TOKEN environment variable.");
  console.error("   Run: GITHUB_TOKEN=your_token node fetch-austrian-repos.mjs");
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

const MIN_STARS = 50;
const ITEMS_PER_PAGE = 100;

const USER_SEARCH_QUERY = `
  query SearchAustrianUsers($queryString: String!, $first: Int!, $after: String) {
    search(query: $queryString, type: USER, first: $first, after: $after) {
      userCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ... on User {
            login
            organizations(first: 100) {
              nodes {
                login
              }
            }
          }
          ... on Organization {
            login
          }
        }
      }
    }
  }
`;

const REPOS_QUERY = `
  query UserRepos($login: String!, $first: Int!, $after: String) {
    user(login: $login) {
      repositories(first: $first, after: $after, ownerAffiliations: OWNER, orderBy: {field: STARGAZERS, direction: DESC}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          nameWithOwner
          description
          url
          stargazerCount
          forkCount
          isFork
          isPrivate
          primaryLanguage {
            name
          }
          licenseInfo {
            name
          }
          updatedAt
          repositoryTopics(first: 10) {
            nodes {
              topic {
                name
              }
            }
          }
        }
      }
    }
  }
`;

const ORG_REPOS_QUERY = `
  query OrgRepos($login: String!, $first: Int!, $after: String) {
    organization(login: $login) {
      repositories(first: $first, after: $after, orderBy: {field: STARGAZERS, direction: DESC}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          nameWithOwner
          description
          url
          stargazerCount
          forkCount
          isFork
          isPrivate
          primaryLanguage {
            name
          }
          licenseInfo {
            name
          }
          updatedAt
          repositoryTopics(first: 10) {
            nodes {
              topic {
                name
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchAustrianUsers(locationQuery) {
  console.log(`Searching for users with location: "${locationQuery}"...`);
  const users = [];
  const orgLogins = new Set();
  let hasNextPage = true;
  let cursor = null;
  let page = 1;

  while (hasNextPage) {
    console.log(`  Page ${page}...`);
    const result = await graphqlWithAuth(USER_SEARCH_QUERY, {
      queryString: `location:"${locationQuery}" repos:>0`,
      first: ITEMS_PER_PAGE,
      after: cursor,
    });

    const { search } = result;
    if (page === 1) console.log(`   Found ${search.userCount} users/orgs.`);

    for (const edge of search.edges) {
      const node = edge.node;
      if (!node?.login) continue;

      users.push(node.login);

      if (node.organizations?.nodes) {
        for (const org of node.organizations.nodes) {
          if (org.login) orgLogins.add(org.login);
        }
      }
    }

    hasNextPage = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
    page++;

    if (users.length >= 1000) {
      console.warn(`  Warning: Search API caps at 1,000 results for "${locationQuery}".`);
      break;
    }
  }

  return { users, orgLogins };
}

async function fetchReposForAccount(login, isOrg) {
  const repos = [];
  let hasNextPage = true;
  let cursor = null;
  const query = isOrg ? ORG_REPOS_QUERY : REPOS_QUERY;
  const rootKey = isOrg ? "organization" : "user";

  while (hasNextPage) {
    let result;
    try {
      result = await graphqlWithAuth(query, {
        login,
        first: ITEMS_PER_PAGE,
        after: cursor,
      });
    } catch (error) {
      if (!isOrg && error.errors?.some((e) => e.type === "NOT_FOUND")) {
        return fetchReposForAccount(login, true);
      }
      break;
    }

    const data = result[rootKey];
    const nodes = data.repositories.nodes;

    if (nodes.length > 0 && nodes[0].stargazerCount < MIN_STARS && cursor === null) break;

    for (const repo of nodes) {
      if (repo.stargazerCount < MIN_STARS) {
        hasNextPage = false;
        break;
      }
      if (!repo.isPrivate && !repo.isFork) repos.push(repo);
    }

    if (hasNextPage) {
      hasNextPage = data.repositories.pageInfo.hasNextPage;
      cursor = data.repositories.pageInfo.endCursor;
    }
  }

  return repos;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const locationQueries = [
      // Country
      "Austria", "Österreich",
      // Landeshauptstädte
      "Wien", "Vienna", "Graz", "Linz", "Salzburg", "Innsbruck",
      "Klagenfurt", "St. Pölten", "Bregenz", "Eisenstadt",
      // Bundesländer (German + English)
      "Kärnten", "Carinthia", "Steiermark", "Styria",
      "Tirol", "Tyrol", "Vorarlberg",
      "Niederösterreich", "Lower Austria",
      "Oberösterreich", "Upper Austria",
      "Burgenland",
      // Other notable cities
      "Villach", "Wels", "Dornbirn", "Wiener Neustadt", "Klosterneuburg",
    ];
    const allUserLogins = new Set();
    const allOrgLogins = new Set();

    for (const loc of locationQueries) {
      const { users, orgLogins } = await fetchAustrianUsers(loc);
      users.forEach((l) => allUserLogins.add(l));
      orgLogins.forEach((l) => allOrgLogins.add(l));
    }

    // Remove orgs that are already in the user set (they'll be tried as user first, fallback to org)
    for (const login of allUserLogins) {
      allOrgLogins.delete(login);
    }

    console.log(`\nFound ${allUserLogins.size} unique Austrian users (+ ${allOrgLogins.size} discovered orgs).\n`);
    console.log(`Fetching repositories with >=${MIN_STARS} stars...\n`);

    const repoMap = new Map();
    let processed = 0;
    const totalAccounts = allUserLogins.size + allOrgLogins.size;

    // Scan user repos
    for (const login of allUserLogins) {
      processed++;
      if (processed % 50 === 0) console.log(`   Progress: ${processed}/${totalAccounts} accounts checked, ${repoMap.size} qualifying repos so far...`);

      const repos = await fetchReposForAccount(login, false);
      for (const repo of repos) {
        if (!repoMap.has(repo.nameWithOwner)) repoMap.set(repo.nameWithOwner, repo);
      }

      if (processed % 20 === 0) await sleep(500);
    }

    // Scan discovered org repos
    console.log(`\nScanning ${allOrgLogins.size} discovered organizations...\n`);
    let orgProcessed = 0;

    for (const login of allOrgLogins) {
      orgProcessed++;
      processed++;
      if (orgProcessed % 20 === 0) console.log(`   Orgs progress: ${orgProcessed}/${allOrgLogins.size}, ${repoMap.size} qualifying repos so far...`);

      const repos = await fetchReposForAccount(login, true);
      for (const repo of repos) {
        if (!repoMap.has(repo.nameWithOwner)) repoMap.set(repo.nameWithOwner, repo);
      }

      if (orgProcessed % 20 === 0) await sleep(500);
    }

    const repos = [...repoMap.values()];
    console.log(`\nFound ${repos.length} repositories with >=${MIN_STARS} stars.\n`);

    repos.sort((a, b) => b.stargazerCount - a.stargazerCount);

    const totalStars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
    const avgStars = repos.length > 0 ? Math.round(totalStars / repos.length) : 0;
    const languages = repos
      .map((r) => r.primaryLanguage?.name)
      .filter(Boolean)
      .reduce((acc, lang) => {
        acc[lang] = (acc[lang] || 0) + 1;
        return acc;
      }, {});

    const topLanguages = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang, count]) => `${lang} (${count})`)
      .join(", ");

    const date = new Date().toISOString().slice(0, 10);

    const lines = [];
    lines.push(`# 🇦🇹 Austrian GitHub Repositories with ≥${MIN_STARS} Stars`);
    lines.push(``);
    lines.push(`> Generated on ${date} · ${repos.length} repositories found`);
    lines.push(``);
    lines.push(`## Summary`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total repositories | ${repos.length} |`);
    lines.push(`| Total stars | ${totalStars.toLocaleString()} |`);
    lines.push(`| Average stars | ${avgStars.toLocaleString()} |`);
    lines.push(`| Top languages | ${topLanguages} |`);
    if (repos.length > 0) {
      lines.push(`| Most starred | [${repos[0].nameWithOwner}](${repos[0].url}) (${repos[0].stargazerCount.toLocaleString()}) |`);
    }
    lines.push(``);
    lines.push(`## Repositories`);
    lines.push(``);
    lines.push(`| # | Repository | Description | ⭐ Stars | 🍴 Forks | Language | License | Topics | Updated |`);
    lines.push(`|---|-----------|-------------|---------|---------|----------|---------|--------|---------|`);

    repos.forEach((repo, i) => {
      const desc = (repo.description ?? "")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .slice(0, 80)
        .trim();
      const language = repo.primaryLanguage?.name ?? "—";
      const license = repo.licenseInfo?.name ?? "—";
      const topics = repo.repositoryTopics.nodes
        .map((n) => `\`${n.topic.name}\``)
        .join(" ") || "—";
      const updated = new Date(repo.updatedAt).toISOString().slice(0, 10);
      const link = `[${repo.nameWithOwner}](${repo.url})`;

      lines.push(
        `| ${i + 1} | ${link} | ${desc} | ${repo.stargazerCount.toLocaleString()} | ${repo.forkCount.toLocaleString()} | ${language} | ${license} | ${topics} | ${updated} |`
      );
    });

    lines.push(``);
    lines.push(`---`);
    lines.push(`*Data sourced from the GitHub GraphQL API. Users located in Austria + their organizations, repos with >=${MIN_STARS} stars.*`);

    const markdown = lines.join("\n");
    const outputFile = "austrian-repos.md";
    writeFileSync(outputFile, markdown, "utf-8");
    console.log(`Saved ${repos.length} repositories to ${outputFile}`);
  } catch (error) {
    if (error.status === 401) {
      console.error("Authentication failed. Check your GITHUB_TOKEN.");
    } else if (error.status === 403) {
      console.error("Rate limit hit or insufficient token scopes.");
    } else {
      console.error("Error:", error.message);
      if (error.errors) error.errors.forEach((e) => console.error("  •", e.message));
    }
    process.exit(1);
  }
}

main();

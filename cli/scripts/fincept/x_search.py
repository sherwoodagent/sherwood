#!/usr/bin/env python3
"""
X/Twitter search via SocialData API ($0.0002/tweet, no scraping).
Requires SOCIALDATA_API_KEY env var.

Usage:
  python3 x_search.py search "crypto quant trading" [--max 20]

Output: JSON with tweets array.
"""

import json
import sys
import os
import argparse
import requests

API_BASE = "https://api.socialdata.tools/twitter"
API_KEY = os.environ.get("SOCIALDATA_API_KEY", "")


def search_tweets(query: str, max_results: int = 20) -> dict:
    """Search recent tweets via SocialData API."""
    if not API_KEY:
        return {"error": "SOCIALDATA_API_KEY not set"}

    try:
        resp = requests.get(
            f"{API_BASE}/search",
            params={"query": query, "type": "Latest"},
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Accept": "application/json",
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.HTTPError as e:
        return {"error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as e:
        return {"error": str(e)}

    raw_tweets = data.get("tweets", [])[:max_results]

    tweets = []
    for t in raw_tweets:
        user = t.get("user", {})
        tweets.append({
            "id": t.get("id_str", ""),
            "text": t.get("full_text", t.get("text", "")),
            "author": user.get("screen_name", "unknown"),
            "author_name": user.get("name", "unknown"),
            "author_followers": user.get("followers_count", 0),
            "created_at": t.get("created_at", ""),
            "likes": t.get("favorite_count", 0),
            "retweets": t.get("retweet_count", 0),
            "replies": t.get("reply_count", 0),
            "views": t.get("views_count", t.get("view_count", 0)),
        })

    return {"tweets": tweets, "count": len(tweets), "query": query}


def main():
    parser = argparse.ArgumentParser(description="X/Twitter search via SocialData API")
    sub = parser.add_subparsers(dest="command")

    search_p = sub.add_parser("search", help="Search recent tweets")
    search_p.add_argument("query", help="Search query")
    search_p.add_argument("--max", type=int, default=20, help="Max results")

    args = parser.parse_args()

    if args.command == "search":
        result = search_tweets(args.query, args.max)
    else:
        result = {"error": "Use: x_search.py search 'query'"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()

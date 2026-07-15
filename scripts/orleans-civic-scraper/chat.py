#!/usr/bin/env python3
"""RAG chat CLI over the Orleans corpus, with source citations.

Requires ANTHROPIC_API_KEY in the environment and a built index (index.py).

Usage:
    python chat.py                          # interactive
    python chat.py "when is the transfer station open?"
"""

from __future__ import annotations

import os
import sys

import anthropic

import config
from index import search

SYSTEM = """You are a helpful assistant for residents of Orleans, Massachusetts.
Answer questions using ONLY the provided excerpts from the town's website and
public documents. Every factual claim must cite its source using [n] markers
matching the numbered excerpts. If the excerpts don't contain the answer, say
so plainly and suggest which town department to contact. Be concise."""


def answer(client: anthropic.Anthropic, question: str) -> str:
    chunks = search(question, top_k=config.TOP_K)
    if not chunks:
        return "No index found or no results -- run crawl.py, extract.py, index.py first."

    context = "\n\n".join(
        f"[{i + 1}] {c['title']}\nURL: {c['url']}\n{c['text']}"
        for i, c in enumerate(chunks)
    )
    msg = client.messages.create(
        model=config.ANTHROPIC_MODEL,
        max_tokens=1024,
        system=SYSTEM,
        messages=[{
            "role": "user",
            "content": f"Excerpts:\n\n{context}\n\nQuestion: {question}",
        }],
    )
    text = msg.content[0].text

    # Append a source list for the citations actually used
    used = sorted({int(m) for m in __import__("re").findall(r"\[(\d+)\]", text)
                   if int(m) <= len(chunks)})
    if used:
        text += "\n\nSources:\n" + "\n".join(
            f"  [{n}] {chunks[n - 1]['title'] or chunks[n - 1]['url']}\n      {chunks[n - 1]['url']}"
            for n in used
        )
    return text


def main() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set ANTHROPIC_API_KEY first.")
    client = anthropic.Anthropic()

    if len(sys.argv) > 1:
        print(answer(client, " ".join(sys.argv[1:])))
        return

    print("Orleans town assistant -- ctrl-d to quit")
    while True:
        try:
            q = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if q:
            print("\n" + answer(client, q))


if __name__ == "__main__":
    main()

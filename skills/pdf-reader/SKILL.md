---
name: pdf-reader
description: Read, analyze, and extract content from PDFs, especially math lecture notes and academic papers. Use when a user asks to read, summarize, or answer questions about a PDF.
---

# PDF Reader

Use text extraction for structure and rendered pages for equations, diagrams,
figures, and other content that text extraction may mangle.

## Setup

`SKILL_DIR` is this skill's directory. If `.venv` is missing, install the
dependency once:

macOS/Linux:

```bash
python3 -m venv SKILL_DIR/.venv
SKILL_DIR/.venv/bin/pip install -r SKILL_DIR/requirements.txt
```

Windows PowerShell:

```powershell
python -m venv SKILL_DIR/.venv
SKILL_DIR/.venv/Scripts/python.exe -m pip install -r SKILL_DIR/requirements.txt
```

Run scripts with `SKILL_DIR/.venv/bin/python` on macOS/Linux or
`SKILL_DIR/.venv/Scripts/python.exe` on Windows.

## Tools

| Script                                                   | Use                                                                |
|----------------------------------------------------------|--------------------------------------------------------------------|
| `pdf_info.py <path>`                                     | Metadata, TOC, page count, text/image/math density                 |
| `pdf_extract.py <path> [--pages SPEC]`                   | Extract text; SPEC is `all`, `1-5`, `1,3,7`, or `3`                |
| `pdf_render.py <path> [--pages SPEC] [--dpi N]`          | Render pages to PNGs in the system temp directory; default 150 DPI |
| `pdf_search.py <path> <query> [--context N] [--literal]` | Search text by regex or literal query                              |

## Workflow

1. Run `pdf_info.py` first for every new PDF. Use its page count, TOC, text
   length, image count, and math density to choose what to inspect visually.
2. Extract text for the structural overview.
3. Render pages as follows:
   - **Up to 15 pages:** extract and render all pages.
   - **15-60 pages:** render pages with `math_density > 0.02`, images, or
     `text_length < 100`; extract the rest.
   - **Over 60 pages:** do not render everything. Search for relevant pages or
     work section by section, and warn the user if the requested scope is broad.
4. For a focused question, run `pdf_search.py`, render the matching page(s),
   and extract adjacent pages when context is needed.
5. When answering, cite page numbers, write equations in LaTeX, and describe
   important diagrams or figures. Use 200 DPI for small or dense equations;
   100 DPI is sufficient for quick visual scans.

Always inspect rendered images when a page is diagram-heavy, image-only, or
contains equations that extraction may have corrupted.

# AgentWeb AG2 Story Documentation

This directory contains the story about AgentWeb's integration with AG2, including the markdown source and generated PDF.

## Prerequisites

To generate the PDF, you need the following tools installed:

1. Pandoc (for markdown to PDF conversion)
2. Mermaid CLI (for diagram generation)
3. XeLaTeX (PDF engine for pandoc)

## Files

- `agentweb_ag2_story.md`: The source markdown file
- `agentweb_ag2_story.pdf`: The generated PDF
- `agentweb_architecture.mmd`: The Mermaid diagram source
- `agentweb_architecture.png`: The generated diagram
- `config.json`: Configuration for Mermaid CLI

## Steps to Generate PDF

1. Generate the architecture diagram:
   ```bash
   mmdc -i agentweb_architecture.mmd -o agentweb_architecture.png -c config.json
   ```

2. Convert markdown to PDF:
   ```bash
   pandoc agentweb_ag2_story.md -o agentweb_ag2_story.pdf --pdf-engine=xelatex
   ```

## Installation Instructions

### macOS (using Homebrew)

```bash
# Install Pandoc
brew install pandoc

# Install Mermaid CLI
brew install mermaid-cli

# Install XeLaTeX (MacTeX)
brew install --cask mactex
```

### Ubuntu/Debian

```bash
# Install Pandoc
sudo apt-get install pandoc

# Install Mermaid CLI
sudo npm install -g @mermaid-js/mermaid-cli

# Install XeLaTeX
sudo apt-get install texlive-xetex
```

## Troubleshooting

If you encounter any issues:

1. Ensure all prerequisites are installed correctly
2. Check that the Mermaid diagram is generated successfully before creating the PDF
3. Verify that XeLaTeX is properly installed and accessible in your PATH

## Notes

- The PDF generation requires XeLaTeX for proper rendering of the document
- The diagram is generated separately to ensure high quality and proper sizing
- The config.json file contains settings for the diagram size and styling 
# Document parser fixtures

`score.docx`, `arrangement.xlsx`, and `arrangement.pptx` are native exports from
python-docx, openpyxl, and python-pptx. They contain project-authored reference
material, Unicode, tables, multiple sheets, an uncached formula, slides, and
speaker notes. Tests read their bytes through the production attachment path.

The fixtures are local test data and are not bundled into the extension.

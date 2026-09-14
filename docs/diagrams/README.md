# The architecture PDF

`../Souqi-Architecture-and-Activity.pdf` is generated, not hand-drawn.

```bash
pip install reportlab
python docs/diagrams/build_souqi_pdf.py docs/Souqi-Architecture-and-Activity.pdf
```

`souqi_diagrams.py` is the drawing layer: UML activity shapes, swimlanes, the
palette taken from the product's own tokens. `build_souqi_pdf.py` is the
document — nine A3 landscape pages.

Everything in it was read out of the repository rather than remembered: route
names, header names, timeouts, image tags, table names, SQL and dependency
versions. When the code moves, regenerate rather than patching the PDF, and
check the page against the file it describes.

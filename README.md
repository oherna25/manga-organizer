# Manga Shelf

A 3D view of a manga collection, built with [three.js](https://threejs.org). Every volume sits on a
bookcase you can orbit around, with real cover art, and you can add or remove books from a side panel.

![The collection in single rows across six bookcases](docs/single-rows.jpg)

## What it does

- **Shows the whole collection in 3D.** Each series gets its own spine, drawn from its cover art.
- **Add and remove books.** Use `+` / `−` on a series to change its volume count, `✕` to remove the
  series, or the form at the top to add a new one. Undo reverses any change.
- **Shows the cover.** Click a book and it slides out and turns to face you.
- **Finds a series.** Search by title or author, then click the row and the camera flies to it.
- **Displays figures.** Open **Figures** to add one by name and size, then drag it to any shelf.
  Figures stand in front of the books: a book can sit behind a figure, never in front of one.

  | Size | Height |
  | --- | --- |
  | Chibi (Nendoroid) | 10 cm |
  | 1/12 (figma) | 14.5 cm |
  | Prize / Pop Up Parade | 18 cm |
  | 1/8 scale | 21 cm |
  | 1/7 scale | 24 cm |
  | 1/6 scale | 28 cm |
  | 1/4 scale | 42 cm |

  In the packed layouts a figure stands at the front edge and the books behind it move to the
  back of the shelf, or flow around it when there is no room behind. In free float, scroll while
  dragging a figure to move it front to back; books in its way are pushed back or moved to
  another gap. A figure needs a shelf tall enough for it, so a 1/4 scale figure needs a shelf
  board moved first.
- **Resizes the bookcase.** Open **Bookcase size** to set the height, width, depth (in inches) and
  the number of shelves, and drag any shelf board up or down in the scene. Every layout repacks
  to fit, and Undo reverses it.
- **Repacks the shelves.** Three packed layouts show how many bookcases the collection needs, and
  free float lets you place every book by hand:

  | Layout | How books are placed |
  | --- | --- |
  | Single rows | One row of upright books per shelf |
  | Efficient | Two rows deep, the back row raised on risers so it stays visible, flat stacks on top of it |
  | Dense | Two rows deep with flat stacks on top of both rows; holds the most, but hides the back row |
| Free float | Wherever you drag them: any shelf, any spot along it, front to back, turned any way up |

  Free float starts from the layout you were in. A book you drop rests on the shelf or on whatever
  is under it, and books left without support fall into place. Use **Add bookcase** for more room,
  **Remove empty** to take out every bookcase with nothing in it, and **Reset places** to go back
  to single rows. Books can be turned in quarter turns to any of
  the 24 ways a book can sit square on a shelf, for example cover out or lying on its back. When
  the bookcase changes size, books that still fit stay where you put them and the rest are moved
  to the first free gap.

  To move a whole series at once, right-click one of its books and then drag any of them: the
  volumes line up in order from where you drop. **Keep a series together** does this on its own
  whenever you drop a book on another shelf, or in another bookcase, than the rest of its series.
  Volumes that do not fit on the shelf carry on into the next gaps. Double-click a fallen or
  turned book to stand it back up; if it cannot stand where it is, it goes against the nearest
  side panel or neighbour that will hold it.

  Free float has simple physics. An upright book falls over unless something holds it up: a side
  panel, a neighbour that reaches at least 30% of its height, or enough books standing together
  (about four). A book facing out needs the back panel or something behind or in front of it. A
  book with something in the way of its fall ends up leaning on that instead. Dropping a book
  within about an inch of a wall or neighbour sets it down against it.

![The efficient layout: back row on risers with flat stacks on top](docs/efficient.jpg)

![A book pulled out to show its cover](docs/cover.jpg)

## Install

You need [Node.js](https://nodejs.org) 20.19 or newer (which includes `npm`) and
[git](https://git-scm.com).

1. Download the project:

   ```bash
   git clone https://github.com/oherna25/manga-organizer.git
   ```

2. Go into the project folder:

   ```bash
   cd manga-organizer
   ```

3. Install the dependencies:

   ```bash
   npm install
   ```

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open the address it prints, normally <http://localhost:5173>, in your browser.

To stop the app, press `Ctrl+C` in the terminal.

## Controls

| Action | How |
| --- | --- |
| Orbit | Drag |
| Pan | Right-drag |
| Zoom | Scroll |
| See a book's cover | Click the book (click again or press `Esc` to put it back) |
| Add or remove a volume of the selected series | `+` / `−` |
| Move a shelf | Drag the shelf board up or down (`Esc` cancels) |
| Move a figure | Drag it; in free float, scroll while dragging to move it front to back |
| Move a book (free float) | Drag it; drag empty space to orbit |
| Push it back or pull it forward (free float) | Scroll while dragging |
| Turn a book (free float) | `R` rolls it, `T` turns it to face another way, `F` tips it over; works on the book you are dragging or pointing at |
| Stand a book back up (free float) | Double-click it |
| Pick a whole series to move together (free float) | Right-click one of its books (again, or `Esc`, lets go) |
| Cancel a move (free float) | `Esc` while dragging |

## Using your own collection

The collection starts from `src/collection.json`, a list of series:

```json
[{ "title": "one piece", "author": "Eiichiro Oda", "count": 90 }]
```

Edits you make in the app are saved in your browser, not in that file. So are free float
positions, figures and the bookcase size, which **Export** does not include. **Export** downloads the current collection as JSON, **Import** loads one, and **Reset** goes back to `src/collection.json`.

To build `src/collection.json` from a spreadsheet with `title`, `author` and `number of books`
columns (needs Python 3):

```bash
python3 scripts/import-xlsx.py "/path/to/manga sheet.xlsx"
```

Then look up cover art for it:

```bash
node scripts/fetch-covers.mjs
```

That writes `src/covers.json`. If a series gets the wrong cover, or none, edit
`scripts/cover-overrides.json` and run the command again:

- `search` maps a title to a better search phrase, for nicknames such as `komi`.
- `ids` pins a title to an exact AniList manga id, or to `null` to skip it.

## Notes

- Cover art comes from [AniList](https://anilist.co) and is loaded from there when the app runs, so
  covers need an internet connection. Adding a series in the app sends its title to AniList to find
  a cover.
- AniList has one cover per series, so every volume of a series shows the same cover.
- Spines are generated from the cover's colour and art. They are not scans of the printed spines.
- The bookcase starts as the Room Essentials 5 Shelf Bookcase (71.18 × 24.49 × 11.57 in) with
  evenly spaced shelves. Every bookcase shares the same shelf positions. A moved board always
  leaves at least one shelf tall enough for any book, and the packed layouts skip shelves that
  are too short for the next book. Changing the height or shelf count spaces the boards evenly
  again, as does **Even shelves**.
- Book thickness and height are generated per series, not measured, so bookcase counts are estimates.
- Figures are drawn as simple stand-ins at typical sizes for each kind, not as models of real figures.

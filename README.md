# Nima

An interactive 1-bit dithered web experience. Each click adds a node of text, threading a path through layered parallax depth. Floating specks drift at different focal planes, rendered through a WebGL blue noise dither pipeline.

## Running locally

```
python3 -m http.server 8000
```

Open [localhost:8000](http://localhost:8000).

## How it works

- **Nodes**: Click to advance through 25 lines of text, connected by dashed paths.
- **Specks**: Procedural floating squares at 5 depth layers, each dithered and blurred based on distance from the focal plane.
- **Dither**: WebGL post-processing pipeline: gaussian blur + blue noise threshold — reduces everything to 1-bit per pixel.
- **Sound**: Sine wave chimes in a 2x6 repeating sequence, ambient rain loop courtesy of [LofiVision](https://pixabay.com/sound-effects/nature-rain-and-wind-chimes-314370/).
- **Colors**: Three-color palette (black, gray, red) cycling with each click.
- **Rewind**: At the end, dissolve everything back to the start

## Tech

Vanilla HTML/CSS/JS. No framework, no build step, no dependencies. Public Sans font via Google Fonts.

## License

GPLv2 — see [LICENSE](LICENSE).

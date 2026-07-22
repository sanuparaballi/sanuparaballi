#!/usr/bin/env node
// Generates an animated SVG showing a genetic algorithm's population
// evolving across a GitHub contribution graph — organisms (dots) evolve
// generation over generation toward the densest (most active) cells.
//
// Usage:
//   GH_TOKEN=xxx GH_USERNAME=yourname node generate.mjs > dist/ea.svg
//
// GH_TOKEN needs at least `read:user` scope (a classic PAT works fine;
// the default GITHUB_ACTIONS token cannot read contribution calendars).

const QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            contributionCount
            weekday
            date
          }
        }
      }
    }
  }
}`;

async function fetchGrid(USERNAME, TOKEN) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  // grid[col][row] = raw contribution count
  const grid = weeks.map((w) => {
    const col = new Array(7).fill(0);
    w.contributionDays.forEach((d) => (col[d.weekday] = d.contributionCount));
    return col;
  });
  return grid;
}

function normalize(grid) {
  const max = Math.max(1, ...grid.flat());
  return grid.map((col) => col.map((v) => v / max));
}

// ── Genetic algorithm over the grid ─────────────────────────────────────────
function runGA(grid, { generations = 30, popSize = 24 } = {}) {
  const cols = grid.length;
  const rows = grid[0].length;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cellAt = (x, y) => grid[clamp(Math.round(x), 0, cols - 1)][clamp(Math.round(y), 0, rows - 1)];

  let pop = Array.from({ length: popSize }, () => ({
    x: Math.random() * cols,
    y: Math.random() * rows,
  }));

  // history[i] = array of {x,y} per generation for organism i
  const history = Array.from({ length: popSize }, (_, i) => [{ ...pop[i] }]);
  // dwell[col][row] = accumulated proximity-weighted visits
  const dwell = grid.map((col) => col.map(() => 0));
  // clearedAt[col][row] = generation index at which dwell crosses threshold, or null
  const clearedAt = grid.map((col) => col.map(() => null));
  const THRESHOLD = 1.4;

  for (let gen = 1; gen <= generations; gen++) {
    // accumulate dwell from current population before evolving
    pop.forEach((o) => {
      const cx = clamp(Math.round(o.x), 0, cols - 1);
      const cy = clamp(Math.round(o.y), 0, rows - 1);
      dwell[cx][cy] += 0.3 + grid[cx][cy] * 0.4;
      if (dwell[cx][cy] >= THRESHOLD && clearedAt[cx][cy] === null && grid[cx][cy] > 0) {
        clearedAt[cx][cy] = gen;
      }
    });

    // rank by fitness (closeness/value of current cell)
    pop.sort((a, b) => cellAt(b.x, b.y) - cellAt(a.x, a.y));
    const survivors = pop.slice(0, Math.floor(popSize / 2));

    const next = survivors.map((o) => ({ ...o }));
    while (next.length < popSize) {
      const p1 = survivors[Math.floor(Math.random() * survivors.length)];
      const p2 = survivors[Math.floor(Math.random() * survivors.length)];
      next.push({
        x: clamp((p1.x + p2.x) / 2 + (Math.random() - 0.5) * (cols * 0.08), 0, cols - 0.01),
        y: clamp((p1.y + p2.y) / 2 + (Math.random() - 0.5) * (rows * 0.3), 0, rows - 0.01),
      });
    }
    pop = next;
    pop.forEach((o, i) => history[i].push({ ...o }));
  }

  return { history, clearedAt, generations };
}

// ── SVG rendering ────────────────────────────────────────────────────────────
function buildSVG(grid, { history, clearedAt, generations }, opts = {}) {
  const cellSize = opts.cellSize ?? 11;
  const gap = 2;
  const cols = grid.length;
  const rows = grid[0].length;
  const pad = 8;
  const totalDur = opts.duration ?? generations * 0.35; // seconds
  const W = cols * (cellSize + gap) + pad * 2;
  const H = rows * (cellSize + gap) + pad * 2;

  const genColor = (v) => {
    if (v === 0) return "#161b22";
    if (v < 0.34) return "#26333d";
    if (v < 0.67) return "#2f4a3d";
    return "#39505d";
  };
  const clearedColor = "#1D9E75";

  let cells = "";
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x = pad + c * (cellSize + gap);
      const y = pad + r * (cellSize + gap);
      const v = grid[c][r];
      const base = genColor(v);
      const clearedGen = clearedAt[c][r];
      let animate = "";
      if (clearedGen) {
        const t = (clearedGen / generations) * totalDur;
        const t0 = Math.max(0, t - 0.01).toFixed(2);
        animate = `<animate attributeName="fill" values="${base};${base};${clearedColor};${clearedColor}" keyTimes="0;${(t0 / totalDur).toFixed(3)};${(t / totalDur).toFixed(3)};1" dur="${totalDur}s" repeatCount="indefinite" />`;
      }
      cells += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${base}">${animate}</rect>\n`;
    }
  }

  const organismColor = "#A29BFE";
  let organisms = "";
  history.forEach((path) => {
    const points = path
      .map((p) => {
        const x = pad + p.x * (cellSize + gap) + cellSize / 2;
        const y = pad + p.y * (cellSize + gap) + cellSize / 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const d = "M " + path
      .map((p, i) => {
        const x = pad + p.x * (cellSize + gap) + cellSize / 2;
        const y = pad + p.y * (cellSize + gap) + cellSize / 2;
        return `${i === 0 ? "" : "L "}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    organisms += `<circle r="2.4" fill="${organismColor}" fill-opacity="0.85">
  <animateMotion dur="${totalDur}s" repeatCount="indefinite" path="${d}" calcMode="linear" />
</circle>\n`;
  });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="none" />
${cells}
${organisms}
</svg>`;
}

async function main() {
  const USERNAME = process.env.GH_USERNAME;
  const TOKEN = process.env.GH_TOKEN;
  if (!USERNAME || !TOKEN) {
    console.error("Set GH_USERNAME and GH_TOKEN env vars.");
    process.exit(1);
  }
  const raw = await fetchGrid(USERNAME, TOKEN);
  const grid = normalize(raw);
  const ga = runGA(grid, { generations: 30, popSize: 24 });
  const svg = buildSVG(grid, ga);
  process.stdout.write(svg);
}

export { fetchGrid, normalize, runGA, buildSVG };

// Only run main() when executed directly (`node generate.mjs`), not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

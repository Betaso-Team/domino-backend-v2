import type { Theme } from "vitepress";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { nextTick, onMounted, watch } from "vue";
import "./mermaid-zoom.css";

const containerObservers = new WeakMap<Element, MutationObserver>();
const initializedSvgs = new WeakSet<SVGElement>();
let svgPanZoom: typeof import("svg-pan-zoom").default | null = null;

async function applyZoom(container: HTMLElement): Promise<void> {
  const svg = container.querySelector("svg");
  if (!svg || initializedSvgs.has(svg)) return;
  initializedSvgs.add(svg);

  if (!svgPanZoom) svgPanZoom = (await import("svg-pan-zoom")).default;

  container.classList.add("mermaid-zoom");
  svg.style.maxWidth = "none";
  svg.style.width = "100%";
  svg.style.height = "100%";

  svgPanZoom(svg, {
    zoomEnabled: true,
    controlIconsEnabled: true,
    fit: true,
    center: true,
    minZoom: 0.2,
    maxZoom: 20,
    zoomScaleSensitivity: 0.3,
    dblClickZoomEnabled: true,
  });
}

function watchContainer(container: HTMLElement): void {
  if (!containerObservers.has(container)) {
    const observer = new MutationObserver(() => void applyZoom(container));
    observer.observe(container, { childList: true });
    containerObservers.set(container, observer);
  }
  void applyZoom(container);
}

function scanForDiagrams(): void {
  for (const container of document.querySelectorAll<HTMLElement>(".mermaid")) {
    watchContainer(container);
  }
}

export default {
  extends: DefaultTheme,
  setup() {
    if (import.meta.env.SSR) return;
    const route = useRoute();
    const run = () => {
      let tries = 0;
      const id = window.setInterval(() => {
        scanForDiagrams();
        if (++tries > 25) window.clearInterval(id);
      }, 200);
    };
    onMounted(run);
    watch(
      () => route.path,
      () => nextTick(run),
    );
  },
} satisfies Theme;

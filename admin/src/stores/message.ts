import { reactive } from 'vue';

export type GlobalMessageType = 'success' | 'error' | 'info' | 'warning';

export interface GlobalMessageItem {
  id: number;
  text: string;
  type: GlobalMessageType;
}

const DEFAULT_DURATION = 2600;
const state = reactive({
  items: [] as GlobalMessageItem[]
});

const timers = new Map<number, number>();
let nextId = 1;

function clearMessageTimer(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
}

function remove(id: number): void {
  clearMessageTimer(id);
  const index = state.items.findIndex((item) => item.id === id);
  if (index >= 0) {
    state.items.splice(index, 1);
  }
}

function push(text: string, type: GlobalMessageType, duration = DEFAULT_DURATION): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return -1;
  }

  const id = nextId++;
  state.items.push({
    id,
    text: trimmed,
    type
  });

  const timer = window.setTimeout(() => {
    remove(id);
  }, duration);
  timers.set(id, timer);

  return id;
}

export function useGlobalMessageState() {
  return state;
}

export function useMessage() {
  return {
    info(text: string, duration?: number): number {
      return push(text, 'info', duration);
    },
    success(text: string, duration?: number): number {
      return push(text, 'success', duration);
    },
    warning(text: string, duration?: number): number {
      return push(text, 'warning', duration);
    },
    error(text: string, duration?: number): number {
      return push(text, 'error', duration);
    },
    dismiss(id: number): void {
      remove(id);
    },
    clear(): void {
      for (const item of [...state.items]) {
        remove(item.id);
      }
    }
  };
}

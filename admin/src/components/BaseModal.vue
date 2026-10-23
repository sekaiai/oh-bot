<template>
  <Teleport to="body">
    <div v-if="shouldRender" v-show="visible" class="app-modal-root" :class="rootClass" @keydown.esc="handleCancel">
      <div class="app-modal-mask" @click="handleMaskClick" />
      <div class="app-modal-shell" @click.self="handleMaskClick">
        <section class="app-modal-card" :style="cardStyle" role="dialog" aria-modal="true">
          <header v-if="hasHeader" class="app-modal-header">
            <slot name="title">
              <strong class="app-modal-title">{{ title }}</strong>
            </slot>
            <button type="button" class="app-modal-close" aria-label="关闭" @click="handleCancel">×</button>
          </header>

          <div class="app-modal-body">
            <slot />
          </div>

          <footer v-if="footer" class="app-modal-footer">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue';

const props = withDefaults(defineProps<{
  visible: boolean;
  title?: string;
  width?: number | string;
  footer?: boolean;
  maskClosable?: boolean;
  unmountOnClose?: boolean;
  modalClass?: string;
}>(), {
  title: '',
  width: 720,
  footer: true,
  maskClosable: true,
  unmountOnClose: false,
  modalClass: ''
});

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'close'): void;
  (event: 'cancel'): void;
}>();

const shouldRender = computed(() => props.visible || !props.unmountOnClose);
const hasHeader = computed(() => Boolean(props.title) || Boolean((useSlots().title)));
const rootClass = computed(() => props.modalClass);
const cardStyle = computed(() => ({
  width: typeof props.width === 'number' ? `${props.width}px` : props.width
}));

function hide(): void {
  emit('update:visible', false);
}

function handleCancel(): void {
  hide();
  emit('cancel');
  emit('close');
}

function handleMaskClick(): void {
  if (props.maskClosable) {
    handleCancel();
  }
}
</script>

<style scoped>
.app-modal-root {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.app-modal-mask {
  position: absolute;
  inset: 0;
  background: rgba(11, 22, 20, 0.52);
  backdrop-filter: blur(6px);
}

.app-modal-shell {
  position: absolute;
  inset: 0;
  padding: 36px 20px;
  display: grid;
  place-items: center;
}

.app-modal-card {
  width: min(100%, 720px);
  max-height: calc(100vh - 72px);
  overflow: auto;
  border: 1px solid rgba(24, 52, 47, 0.12);
  border-radius: 28px;
  background: rgba(255, 251, 245, 0.98);
  box-shadow: 0 28px 80px rgba(20, 31, 29, 0.18);
}

.app-modal-header {
  padding: 22px 24px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.app-modal-title {
  font-size: 18px;
}

.app-modal-close {
  width: 36px;
  height: 36px;
  border: 1px solid rgba(24, 52, 47, 0.12);
  border-radius: 999px;
  color: #33534c;
  background: rgba(255, 255, 255, 0.82);
  font-size: 20px;
  line-height: 1;
}

.app-modal-body {
  padding: 12px 24px 24px;
}

.app-modal-footer {
  padding: 0 24px 24px;
}

@media (max-width: 720px) {
  .app-modal-shell {
    padding: 12px;
  }

  .app-modal-card {
    max-height: calc(100vh - 24px);
    border-radius: 24px;
  }

  .app-modal-header,
  .app-modal-body,
  .app-modal-footer {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>

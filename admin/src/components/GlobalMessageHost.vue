<template>
  <Teleport to="body">
    <div v-if="state.items.length" class="global-message-stack" role="status" aria-live="polite">
      <article
        v-for="item in state.items"
        :key="item.id"
        class="global-message"
        :class="`global-message-${item.type}`"
      >
        <span class="global-message-dot" aria-hidden="true" />
        <p>{{ item.text }}</p>
        <button type="button" class="global-message-close" @click="dismiss(item.id)">
          关闭
        </button>
      </article>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useGlobalMessageState, useMessage } from '../stores/message';

const state = useGlobalMessageState();
const { dismiss } = useMessage();
</script>

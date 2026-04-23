import { defineStore } from 'pinia';
import { post, put, request } from '../api/client';
import type {
  ScheduledTask,
  ScheduledTaskExecutionLog,
  ScheduledTasksResponse,
  TaskTargetOption
} from '../types';

interface TaskState {
  tasks: ScheduledTask[];
  targets: TaskTargetOption[];
  loading: boolean;
  saving: boolean;
  runningIds: string[];
}

export const useTasksStore = defineStore('tasks', {
  state: (): TaskState => ({
    tasks: [],
    targets: [],
    loading: false,
    saving: false,
    runningIds: []
  }),
  actions: {
    async fetchAll(): Promise<void> {
      this.loading = true;
      try {
        const [tasksResponse, targets] = await Promise.all([
          request<ScheduledTasksResponse>('/admin/tasks'),
          request<TaskTargetOption[]>('/admin/task-targets')
        ]);
        this.tasks = tasksResponse.tasks;
        this.targets = targets;
      } finally {
        this.loading = false;
      }
    },
    async saveTasks(tasks: ScheduledTask[]): Promise<void> {
      this.saving = true;
      try {
        await put<{ ok: boolean }>('/admin/tasks', { tasks });
        this.tasks = tasks;
      } finally {
        this.saving = false;
      }
    },
    async runTask(taskId: string): Promise<ScheduledTaskExecutionLog> {
      this.runningIds = [...this.runningIds, taskId];
      try {
        const log = await post<ScheduledTaskExecutionLog>(`/admin/tasks/${taskId}/run`);
        const task = this.tasks.find((item) => item.id === taskId);
        if (task) {
          task.lastRunAt = log.executedAt;
          task.lastRunScheduledFor = log.scheduledFor;
          task.lastRunStatus = log.status;
          task.lastRunMessage = log.message;
          task.logs = [log, ...(task.logs ?? [])].slice(0, 20);
        }
        return log;
      } finally {
        this.runningIds = this.runningIds.filter((item) => item !== taskId);
      }
    }
  }
});

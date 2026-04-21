import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import DashboardView from '../views/DashboardView.vue';
import LoginView from '../views/LoginView.vue';
import RulesView from '../views/RulesView.vue';
import PersonasView from '../views/PersonasView.vue';
import SessionsView from '../views/SessionsView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', name: 'dashboard', component: DashboardView, meta: { requiresAuth: true } },
    { path: '/rules', name: 'rules', component: RulesView, meta: { requiresAuth: true } },
    { path: '/personas', name: 'personas', component: PersonasView, meta: { requiresAuth: true } },
    { path: '/sessions', name: 'sessions', component: SessionsView, meta: { requiresAuth: true } }
  ]
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (!auth.authenticated && !auth.loading && to.name !== 'login') {
    await auth.restore();
  }

  if (to.meta.requiresAuth && !auth.authenticated) {
    return { name: 'login' };
  }

  if (to.name === 'login' && auth.authenticated) {
    return { name: 'dashboard' };
  }

  return true;
});

export default router;

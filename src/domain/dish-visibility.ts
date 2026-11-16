import type { DishVisibilityStore } from '../ports/dish-visibility-store.js';

export class DenyAllDishVisibilityStore implements DishVisibilityStore {
  async isVisibleToEmployee(_userId: string, _dishId: string): Promise<boolean> {
    return false;
  }
}

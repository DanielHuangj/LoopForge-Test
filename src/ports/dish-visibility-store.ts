export interface DishVisibilityStore {
  isVisibleToEmployee(userId: string, dishId: string): Promise<boolean>;
}

import {
  createProduct,
  getProductDetail,
  listProducts,
  updateProductItemsPerCell,
} from "./inventory.js";

export function createCatalogService({ db }) {
  return {
    listProducts(search = "") {
      return listProducts(db, search);
    },
    getProductDetail(productId) {
      return getProductDetail(db, productId);
    },
    createProduct(input) {
      return createProduct(db, input);
    },
    updateProductItemsPerCell(input) {
      return updateProductItemsPerCell(db, input);
    },
  };
}

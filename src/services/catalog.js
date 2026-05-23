import {
  createProduct,
  getProductDetail,
  listProducts,
  removeProduct,
  updateProductDetails,
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
    removeProduct(productId) {
      return removeProduct(db, productId);
    },
    updateProductDetails(input) {
      return updateProductDetails(db, input);
    },
    updateProductItemsPerCell(input) {
      return updateProductItemsPerCell(db, input);
    },
  };
}

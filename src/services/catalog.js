import {currentActor} from "../modules/access/service.js";
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
      currentActor(db,input.actor,"products.add");
      return createProduct(db, input);
    },
    removeProduct(productId,actor) {
      currentActor(db,actor,"products.remove");
      return removeProduct(db, productId);
    },
    updateProductDetails(input) {
      currentActor(db,input.actor,"products.edit");
      return updateProductDetails(db, input);
    },
    updateProductItemsPerCell(input) {
      currentActor(db,input.actor,"products.capacity");
      return updateProductItemsPerCell(db, input);
    },
  };
}

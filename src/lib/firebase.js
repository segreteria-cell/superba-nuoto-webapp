import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { getDatabase } from "firebase/database"

const firebaseConfig = {
  apiKey: "AIzaSyAHltrKcgzsv8vZsfOLIa7-8c65IAOIsCI",
  authDomain: "superbanuotoprogettoficr.firebaseapp.com",
  projectId: "superbanuotoprogettoficr",
  storageBucket: "superbanuotoprogettoficr.firebasestorage.app",
  messagingSenderId: "410612430773",
  appId: "1:410612430773:web:aa6bc32b9a98769acb0bfc",
  databaseURL: "https://superbanuotoprogettoficr-default-rtdb.europe-west1.firebasedatabase.app",
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const rtdb = getDatabase(app)

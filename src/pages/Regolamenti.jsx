import { useState, useRef, useCallback, useEffect } from 'react'
import { db, storage } from '../lib/firebase'
import {
  collection, addDoc, getDocs, deleteDoc, doc, query, orderBy,
} from 'firebase/firestore'
import {
  ref, uploadBytesResumable, getDownloadURL, deleteObject,
} from 'firebase/storage'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorke
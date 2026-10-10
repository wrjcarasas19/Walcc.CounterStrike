package main

import (
	"errors"
	"sync"
)

// FixedArray is a fixed-size slot table. Each slot has a generation that
// changes whenever the slot is freed, so a holder of a stale (index,
// generation) pair cannot Replace or Remove the slot after it was reused.
type FixedArray[T any] struct {
	data     []T
	inUse    []bool
	gen      []uint32
	capacity byte
	lock     sync.RWMutex
	freeList []byte
}

// NewFixedArray initializes the fixed-size array
func NewFixedArray[T any](size byte) *FixedArray[T] {
	free := make([]byte, size)
	var i byte = 0
	for ; i < size; i++ {
		free[i] = size - 1 - i
	}
	return &FixedArray[T]{
		data:     make([]T, size),
		inUse:    make([]bool, size),
		gen:      make([]uint32, size),
		capacity: size,
		freeList: free,
	}
}

var (
	errArrayFull       = errors.New("array is full")
	errOutOfBounds     = errors.New("index out of bounds")
	errNotInUse        = errors.New("index not in use")
	errStaleGeneration = errors.New("stale slot generation")
)

// Add stores item in a free slot and returns its index and generation (O(1)).
func (fa *FixedArray[T]) Add(item T) (byte, uint32, error) {
	fa.lock.Lock()
	defer fa.lock.Unlock()

	if len(fa.freeList) == 0 {
		return 0, 0, errArrayFull
	}
	idx := fa.freeList[len(fa.freeList)-1]
	fa.freeList = fa.freeList[:len(fa.freeList)-1]

	fa.data[idx] = item
	fa.inUse[idx] = true
	return idx, fa.gen[idx], nil
}

// Get retrieves a value by index (O(1))
func (fa *FixedArray[T]) Get(index byte) (T, error) {
	fa.lock.RLock()
	defer fa.lock.RUnlock()

	var zero T
	if index >= fa.capacity {
		return zero, errOutOfBounds
	}
	if !fa.inUse[index] {
		return zero, errNotInUse
	}
	return fa.data[index], nil
}

// check reports whether (index, generation) names a slot that is in use.
// The caller must hold fa.lock.
func (fa *FixedArray[T]) check(index byte, generation uint32) error {
	if index >= fa.capacity {
		return errOutOfBounds
	}
	if !fa.inUse[index] {
		return errNotInUse
	}
	if fa.gen[index] != generation {
		return errStaleGeneration
	}
	return nil
}

// Remove frees the slot if it still belongs to the given generation (O(1)).
func (fa *FixedArray[T]) Remove(index byte, generation uint32) error {
	fa.lock.Lock()
	defer fa.lock.Unlock()

	if err := fa.check(index, generation); err != nil {
		return err
	}

	var zero T
	fa.data[index] = zero
	fa.inUse[index] = false
	fa.gen[index]++
	fa.freeList = append(fa.freeList, index)
	return nil
}

// Replace overwrites the slot if it still belongs to the given generation.
func (fa *FixedArray[T]) Replace(index byte, generation uint32, newValue T) error {
	fa.lock.Lock()
	defer fa.lock.Unlock()

	if err := fa.check(index, generation); err != nil {
		return err
	}
	fa.data[index] = newValue
	return nil
}

// Items returns the values of the slots in use, in slot order.
func (fa *FixedArray[T]) Items() []T {
	fa.lock.RLock()
	defer fa.lock.RUnlock()

	var items []T
	for i, used := range fa.inUse {
		if used {
			items = append(items, fa.data[i])
		}
	}
	return items
}
